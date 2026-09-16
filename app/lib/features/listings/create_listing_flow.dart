
import '../../core/localization/ui_text.dart';

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
// [UI-DS-SWEEP-1] migrated off core/ui/zine.dart onto AD / ADText / Msg.
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/motion/motion.dart';
import '../avavoice/studio/agent_form_flow.dart';
import '../avavision/studio/agent_form_flow.dart' as avavision;
import '../explore/listing_detail.dart';
import '../explore/widgets.dart';
import '../identity/identity_gate.dart';
import '../translation/translation_langs.dart';
import 'share_live_event_sheet.dart';

/// Phase 6 creator pipeline — guided stepper:
/// 1 type · 2 title/description/category · 3 price (+capacity | date/time, with
/// pricing extras A5) · 4 cover photos · 5 icons (country, 18+, badges) ·
/// 6 preview-as-buyer (REAL details widget, A6) → Publish (KYC gate).
///
/// Visuals: AvaTOK design system ("Create Listing" flow, restyled from the
/// legacy mockup into the zine system) — ink-ringed step rail, bordered cards,
/// lime Continue, sticker hints.
class CreateListingFlow extends StatefulWidget {
  /// When supplied by the Phase 2 service chooser, the wizard opens directly
  /// on content entry and keeps the commercial product type fixed. The legacy
  /// creator entry remains unchanged when this is null.
  final String? initialKind;

  const CreateListingFlow({super.key, this.initialKind})
      : assert(initialKind == null ||
            initialKind == 'live_event' ||
            initialKind == 'consult');
  @override
  State<CreateListingFlow> createState() => _CreateListingFlowState();
}

class _CreateListingFlowState extends State<CreateListingFlow> {
  int _step = 0;
  late String _kind;
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
  int _refundWindowHours = 24;
  int _cancellationWindowHours = 24;
  bool _rescheduleAllowed = true;
  int _bookingNoticeHours = 2;
  final _preparationInstructions = TextEditingController();

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
    _kind = widget.initialKind ?? 'live_event';
    if (widget.initialKind != null) _step = 1;
    ListingsApi.categories().then((c) {
      if (mounted && c.isNotEmpty) setState(() => _cats = c);
    });
    final initialKind = widget.initialKind;
    if (initialKind != null) {
      Analytics.capture('listing_pipeline_opened', {
        'commercial_kind': initialKind,
      });
    }
  }

  /// The field takes rupees and 1 token = ₹1, so there is no ×100 here.
  int get _priceTokens {
    final rupees = double.tryParse(_price.text.trim()) ?? 0;
    return rupees.round().clamp(0, 1000000).toInt();
  }

  List<String> get _badges => [
        if (_language.text.trim().isNotEmpty) '🗣 ${_language.text.trim()}',
      ];

  Map<String, dynamic> get _commercialAttrs => widget.initialKind == null
      ? const <String, dynamic>{}
      : {
          if (_kind == 'live_event')
            'commercial_refund_window_hours': _refundWindowHours,
          if (_kind == 'consult') ...{
            'commercial_cancellation_window_hours': _cancellationWindowHours,
            'commercial_reschedule_allowed': _rescheduleAllowed,
            'commercial_booking_notice_hours': _bookingNoticeHours,
            'commercial_preparation_instructions':
                _preparationInstructions.text.trim(),
            'commercial_no_show_policy': 'session_charged',
          },
        };

  ListingCard _draftCard() => ListingCard.fromJson({
        'id': 'draft',
        'kind': _kind,
        'title': _title.text.trim().isEmpty ? 'Untitled' : _title.text.trim(),
        'one_liner': _desc.text.trim().split('\n').first,
        'description': _desc.text.trim(),
        'category': _category,
        'status': 'draft',
        'price': _priceTokens,
        'effective_price': _priceTokens,
        'promo_pct': 0,
        'currency_display': 'TOKENS',
        'country': _country.text.trim().isEmpty
            ? null
            : _country.text.trim().toUpperCase(),
        'adults_only': _adultsOnly,
        'badges': _badges,
        'cover_media': [
          for (final u in _coverUrls) {'type': 'image', 'url': u}
        ],
        'starts_at':
            _kind == 'live_event' ? _start?.millisecondsSinceEpoch : null,
        'duration_min': _duration,
        'capacity': _kind == 'consult' ? _capacity : null,
        'joined_count': 0,
        'rating_count': 0,
        'translation_enabled': _translationEnabled,
        'spoken_lang': _spokenLang,
        'attrs': _commercialAttrs,
        'creator': {'uid': '', 'name': 'You', 'kyc_verified': true},
      });

  Future<void> _pickCover() async {
    if (_coverUrls.length >= 5 || _uploading) return;
    final x = await ImagePicker().pickImage(
        source: ImageSource.gallery, maxWidth: 1600, imageQuality: 85);
    if (x == null) return;
    setState(() => _uploading = true);
    try {
      final bytes = await x.readAsBytes();
      final res = await ApiAuth.postBytes(kUploadPublicUrl, bytes,
          extraHeaders: {'x-content-type': 'image/jpeg'},
          timeout: const Duration(seconds: 60));
      if (res.statusCode == 200) {
        final url = (jsonDecode(res.body) as Map)['url']?.toString();
        if (url != null && url.isNotEmpty && mounted)
          setState(() => _coverUrls.add(url));
      }
    } catch (_) {/* keep UI responsive */}
    if (mounted) setState(() => _uploading = false);
  }

  bool _validStep(int s) {
    switch (s) {
      case 1:
        return _title.text.trim().isNotEmpty;
      case 2:
        if (_kind == 'live_event')
          return _start != null && _start!.isAfter(DateTime.now());
        return true;
      case 3:
        return _coverUrls.isNotEmpty; // at least one photo required
      default:
        return true;
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
    if (_step == 0 && _kind == 'ai_vision_agent') {
      Analytics.capture('listing_pipeline_ai_vision_agent_handoff');
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const avavision.AgentFormFlow()),
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
    setState(() {
      _error = null;
      if (_step < 5) _step++;
    });
  }

  void _back() {
    if (widget.initialKind != null && _step <= 1) {
      Navigator.pop(context);
      return;
    }
    if (_step > 0) {
      setState(() {
        _error = null;
        _step--;
      });
    } else {
      Navigator.pop(context);
    }
  }

  Future<void> _publish() async {
    if (_coverUrls.isEmpty) {
      setState(() {
        _step = 3;
        _error = 'Add at least one photo (up to 5) before publishing.';
      });
      return;
    }
    setState(() {
      _publishing = true;
      _error = null;
    });
    // KYC gate intercepts here if unverified (server enforces too: API 403).
    final ok =
        await IdentityGate.ensureVerified(context, reason: 'publish a listing');
    if (!ok) {
      setState(() => _publishing = false);
      return;
    }

    final id = await ListingsApi.createDraft(_kind, {
      'title': _title.text.trim(),
      'description': _desc.text.trim(),
      'category': _category,
      'price': _priceTokens,
      'country': _country.text.trim().isEmpty
          ? null
          : _country.text.trim().toUpperCase(),
      'adults_only': _adultsOnly,
      'badges': _badges,
      'cover_media': [
        for (final u in _coverUrls) {'type': 'image', 'url': u}
      ],
      if (_kind == 'live_event') 'starts_at': _start!.millisecondsSinceEpoch,
      'duration_min': _duration,
      if (_kind == 'consult') 'capacity': _capacity,
      'translation_enabled': _translationEnabled,
      'spoken_lang': _spokenLang,
      if (widget.initialKind != null) 'attrs': _commercialAttrs,
    });
    if (id == null) {
      if (mounted)
        setState(() {
          _publishing = false;
          _error = 'Could not save the listing — try again.';
        });
      return;
    }
    // A5 pricing extras before publish.
    if (_earlyBird && (int.tryParse(_ebPct.text) ?? 0) > 0) {
      await ListingsApi.addPromotion(id,
          kind: 'early_bird',
          pctOff: int.parse(_ebPct.text),
          endsAt:
              (_ebEnds ?? _start ?? DateTime.now().add(const Duration(days: 7)))
                  .millisecondsSinceEpoch);
    }
    if (_promoCode.text.trim().isNotEmpty &&
        (int.tryParse(_promoPct.text) ?? 0) > 0) {
      await ListingsApi.addPromotion(id,
          kind: 'promo_code',
          pctOff: int.parse(_promoPct.text),
          code: _promoCode.text.trim().toUpperCase(),
          maxUses: int.tryParse(_promoMax.text));
    }
    final r = await ListingsApi.publish(id);
    if (!mounted) return;
    if (r['ok'] == true) {
      Analytics.capture('listing_published_client', {'kind': _kind});
      HapticFeedback.mediumImpact(); // P9: tactile publish confirmation
      if (widget.initialKind == 'live_event') {
        await showShareLiveEventSheet(
          context,
          listingId: id,
          title: _title.text.trim(),
          startsAt: _start?.millisecondsSinceEpoch,
        );
        if (!mounted) return;
      }
      Navigator.pop(context, true);
      showAdToast(context, message: widget.initialKind == null
              ? 'Published! Your listing is live in AvaExplore.'
              : 'Published! Your service is now visible in Marketplace.');
      return;
    }
    setState(() {
      _publishing = false;
      final err = r['error']?.toString();
      if (err == 'conflict') {
        final c = r['conflictWith'] as Map?;
        _error =
            'That time slot is occupied${c != null ? ' by "${c['title'] ?? c['source_app']}"' : ''} — pick another time.';
      } else if (r['reason'] == 'kyc') {
        _error = 'Identity verification required before publishing.';
      } else if (err == 'no_availability') {
        _error =
            'Set your availability in AvaCalendar first, then publish this consult listing.';
      } else {
        _error = r['detail']?.toString() ?? err ?? 'Publish failed.';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      appBar: ZineAppBar(
        title: widget.initialKind == null
            ? uiCopy(UiMessage.m_new_listing_706a22635b)
            : _kind == 'live_event'
                ? uiCopy(UiMessage.m_create_live_event_dff65f7ea7)
                : uiCopy(UiMessage.m_create_consultation_ce5156ef13),
        markWord: widget.initialKind == null ? 'listing' : 'Create',
        tag: 'creator · ${_step + 1} / 6',
      ),
      body: ZinePaper(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
          children: [
            for (var i = 0; i < 6; i++) _stepBlock(i),
          ],
        ),
      ),
    );
  }

  // ---- zine stepper chrome -------------------------------------------------

  Widget _stepBlock(int i) {
    final state = i == _step
        ? _StepState.active
        : (i < _step ? _StepState.done : _StepState.todo);
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
                child: Container(
                    width: 2.5,
                    color: AD.textPrimary.withValues(alpha: 0.25),
                    margin: const EdgeInsets.symmetric(vertical: Msg.s1)),
              ),
          ]),
        ),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(bottom: last ? 0 : 18),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              GestureDetector(
                // can only jump to current or already-reached steps
                onTap: state == _StepState.todo
                    ? null
                    : () => setState(() {
                          _error = null;
                          _step = i;
                        }),
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: Msg.s1),
                  child: Text(_stepTitles[i],
                      style: ADText.appTitle(
                          c: state == _StepState.todo
                              ? AD.textTertiary
                              : AD.textPrimary)),
                ),
              ),
              if (state == _StepState.active) ...[
                const SizedBox(height: Msg.s2),
                ZineCard(
                  color: AD.card,
                  padding: const EdgeInsets.all(Msg.s4),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _stepBody(i),
                        if (_error != null) ZineErrorMsg(_error!),
                        const SizedBox(height: Msg.s4),
                        Row(children: [
                          Expanded(
                            child: i == 5
                                ? ZineButton(
                                    label: uiCopy(UiMessage.m_publish_859390eb49),
                                    icon: PhosphorIcons.rocketLaunch(
                                        PhosphorIconsStyle.bold),
                                    fullWidth: true,
                                    fontSize: 18,
                                    loading: _publishing,
                                    onPressed: _publishing ? null : _publish,
                                  )
                                : ZineButton(
                                    label: uiCopy(UiMessage.m_continue_31fbef1625),
                                    icon: PhosphorIcons.arrowRight(
                                        PhosphorIconsStyle.bold),
                                    fullWidth: true,
                                    fontSize: 18,
                                    onPressed: _continue,
                                  ),
                          ),
                          const SizedBox(width: Msg.s3),
                          ZineLink(i == 0 ? 'cancel' : 'back',
                              fontSize: 14, onTap: _back),
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
      _StepState.active => (AD.primaryBadge, AD.textPrimary),
      _StepState.done => (AD.textPrimary, AD.bg),
      _StepState.todo => (AD.card, AD.textTertiary),
    };
    return Container(
      width: 34,
      height: 34,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: fill,
        border: Border.all(
            color: state == _StepState.todo ? AD.textTertiary : AD.borderCard,
            width: 1),
        boxShadow: state == _StepState.active ? const <BoxShadow>[] : null,
      ),
      child: Center(
        child: state == _StepState.done
            ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                size: 16, color: fg)
            : Text('${i + 1}',
                style: TextStyle(
                    fontFamily: ADText.family,
                    fontWeight: FontWeight.w600,
                    fontSize: 16,
                    color: fg)),
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
  Widget _stepType() => widget.initialKind != null
      ? Column(children: [
          if (_kind == 'live_event')
            _radioCard(
              'live_event',
              'Live event',
              'Ticketed one-to-many stream through GetStream',
              PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
              AD.danger,
              enabled: false,
            )
          else
            _radioCard(
              'consult',
              '1:1 consultation',
              'Private paid video booking through GetStream',
              PhosphorIcons.user(PhosphorIconsStyle.bold),
              AD.micIdleBg,
              enabled: false,
            ),
        ])
      : Column(children: [
          _radioCard(
              'live_event',
              'Live event',
              'Stream to many viewers at a set time (AvaLive)',
              PhosphorIcons.broadcast(PhosphorIconsStyle.bold),
              AD.danger),
          const SizedBox(height: Msg.s3),
          _radioCard(
              'consult',
              'Consultation',
              'Bookable 1:1 or small-group sessions from your availability',
              PhosphorIcons.user(PhosphorIconsStyle.bold),
              AD.micIdleBg),
          const SizedBox(height: Msg.s3),
          _radioCard(
              'ai_agent',
              'AI voice agent',
              'A Gemini-powered voice agent callers can talk to 24/7 (AvaVoice)',
              PhosphorIcons.robot(PhosphorIconsStyle.bold),
              AD.primaryBadge),
          const SizedBox(height: Msg.s3),
          _radioCard(
              'ai_vision_agent',
              'AI vision agent',
              'A camera coach that SEES the user — form, technique, live score (AvaVision)',
              PhosphorIcons.eye(PhosphorIconsStyle.bold),
              AD.micIdleBg),
        ]);

  Widget _radioCard(
      String value, String title, String sub, IconData icon, Color accent,
      {bool enabled = true}) {
    final sel = _kind == value;
    return ZinePressable(
      onTap: enabled ? () => setState(() => _kind = value) : null,
      color: sel ? AD.newGroup : AD.card,
      radius: BorderRadius.circular(Msg.rLg),
      boxShadow: sel ? const <BoxShadow>[] : const <BoxShadow>[],
      padding: const EdgeInsets.all(Msg.s4),
      child: Row(children: [
        Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: AD.card,
            border: Border.all(color: AD.borderCard, width: 1),
          ),
          child: sel
              ? Center(
                  child: Container(
                      width: 9,
                      height: 9,
                      decoration: const BoxDecoration(
                          shape: BoxShape.circle, color: AD.textPrimary)))
              : null,
        ),
        const SizedBox(width: Msg.s3),
        ZineIconBadge(icon: icon, color: accent, size: 30),
        const SizedBox(width: Msg.s3),
        Expanded(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.threadName()),
            const SizedBox(height: 2),
            Text(sub, style: ADText.preview()),
          ]),
        ),
      ]),
    );
  }

  // ---- step 2: title / description / category ----
  Widget _stepText() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _title,
          label: uiCopy(UiMessage.m_title_aaf2320646),
          labelIcon: PhosphorIcons.textT(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_e_g_vedic_chart_reading_ad9ed05e87),
          maxLength: 140,
          textCapitalization: TextCapitalization.sentences,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: Msg.s4),
        ZineField(
          controller: _desc,
          label: uiCopy(UiMessage.m_description_c9046f7a37),
          labelIcon: PhosphorIcons.article(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_what_attendees_will_get_858b1a7816),
          maxLines: 4,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: Msg.s4),
        ZineDropdown<String>(
          label: uiCopy(UiMessage.m_category_edb2cd3b74),
          value: _category,
          items: [
            if (_cats.isEmpty)
              const DropdownMenuItem(
                  value: 'teachers', child: UiText(UiMessage.m_teachers_33c512c6ee)),
            for (final c in _cats)
              DropdownMenuItem(
                  value: c.id, child: Text('${c.emoji} ${c.label}')),
          ],
          onChanged: (v) => setState(() => _category = v ?? 'teachers'),
        ),
      ]);

  // ---- step 3: price & schedule ----
  Widget _stepPrice() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _price,
          label: uiCopy(UiMessage.m_price_8e7f4ffcfc),
          labelIcon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
          leadText: '₹',
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
        ),
        const SizedBox(height: Msg.s2),
        const ZineSticker('0 = free', kind: ZineStickerKind.hint),
        const SizedBox(height: Msg.s4),
        if (_kind == 'consult') ...[
          if (widget.initialKind == 'consult')
            Container(
              padding: const EdgeInsets.all(Msg.s3),
              decoration: BoxDecoration(
                color: AD.micIdleBg,
                borderRadius: BorderRadius.circular(Msg.rMd),
                border: Border.all(color: AD.borderControl),
              ),
              child: Row(children: [
                PhosphorIcon(
                  PhosphorIcons.userFocus(PhosphorIconsStyle.bold),
                  size: 19,
                  color: AD.textPrimary,
                ),
                const SizedBox(width: Msg.s2),
                Expanded(
                  child: UiText(
                    UiMessage.m_private_1_1_consultation_one_861631a453,
                    style: ADText.preview(c: AD.textPrimary),
                  ),
                ),
              ]),
            )
          else ...[
            UiText(UiMessage.m_group_size_f501715b64, style: ADText.sectionLabel()),
            const SizedBox(height: Msg.s2),
            Row(children: [
              for (final c in const [1, 10, 20]) ...[
                Expanded(
                  child: ZineChip(
                    label: c == 1 ? '1:1' : uiCopy(UiMessage.m_up_to_c_8bfe308c96, {'c': (c).toString()}),
                    active: _capacity == c,
                    onTap: () => setState(() => _capacity = c),
                  ),
                ),
                if (c != 20) const SizedBox(width: Msg.s2),
              ],
            ]),
          ],
          const SizedBox(height: Msg.s4),
        ],
        if (_kind == 'live_event') ...[
          ZinePressable(
            onTap: _pickWhen,
            color: _start == null ? AD.card : AD.newGroup,
            radius: BorderRadius.circular(Msg.rMd),
            padding: const EdgeInsets.symmetric(
                horizontal: Msg.s4, vertical: Msg.s4),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
                  size: 19, color: AD.textPrimary),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: Text(
                  _start == null
                      ? uiCopy(UiMessage.m_pick_date_time_8dc91a44f2)
                      : fmtWhen(_start!.millisecondsSinceEpoch),
                  style: ADText.rowName(),
                ),
              ),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                  size: 16, color: AD.textSecondary),
            ]),
          ),
          const SizedBox(height: Msg.s2),
          UiText(
              UiMessage.m_if_the_time_conflicts_with_bbc5415cf4,
              style: ADText.preview()),
          const SizedBox(height: Msg.s4),
        ],
        Row(children: [
          Expanded(child: UiText(UiMessage.m_duration_4fc52a3c4c, style: ADText.sectionLabel())),
          SizedBox(
            width: 132,
            child: ZineDropdown<int>(
              value: _duration,
              items: [
                for (final m in const [15, 30, 45, 60, 90, 120, 180])
                  DropdownMenuItem(value: m, child: UiText(UiMessage.m_m_min_b8b9f90dff, params: {'m': (m).toString()}))
              ],
              onChanged: (v) => setState(() => _duration = v ?? 60),
            ),
          ),
        ]),
        if (widget.initialKind != null) ...[
          const SizedBox(height: Msg.s4),
          Text(
            _kind == 'live_event' ? uiCopy(UiMessage.m_ticket_refund_policy_7d1cfbb573) : uiCopy(UiMessage.m_booking_policy_58e3fced1c),
            style: ADText.sectionLabel(),
          ),
          const SizedBox(height: Msg.s2),
          if (_kind == 'live_event')
            ZineDropdown<int>(
              label: uiCopy(UiMessage.m_customer_cancellation_deadline_359276e1fa),
              value: _refundWindowHours,
              items: const [
                DropdownMenuItem(value: 48, child: UiText(UiMessage.m_48_hours_before_406d1049a0)),
                DropdownMenuItem(value: 24, child: UiText(UiMessage.m_24_hours_before_7dc76e45dd)),
                DropdownMenuItem(value: 12, child: UiText(UiMessage.m_12_hours_before_86e15248a2)),
                DropdownMenuItem(value: 0, child: UiText(UiMessage.m_non_refundable_9916b61a64)),
              ],
              onChanged: (v) => setState(() => _refundWindowHours = v ?? 24),
            )
          else ...[
            ZineDropdown<int>(
              label: uiCopy(UiMessage.m_customer_cancellation_deadline_359276e1fa),
              value: _cancellationWindowHours,
              items: const [
                DropdownMenuItem(value: 48, child: UiText(UiMessage.m_48_hours_before_406d1049a0)),
                DropdownMenuItem(value: 24, child: UiText(UiMessage.m_24_hours_before_7dc76e45dd)),
                DropdownMenuItem(value: 12, child: UiText(UiMessage.m_12_hours_before_86e15248a2)),
                DropdownMenuItem(value: 0, child: UiText(UiMessage.m_non_refundable_9916b61a64)),
              ],
              onChanged: (v) =>
                  setState(() => _cancellationWindowHours = v ?? 24),
            ),
            const SizedBox(height: Msg.s3),
            ZineDropdown<int>(
              label: uiCopy(UiMessage.m_minimum_booking_notice_4ade523a4d),
              value: _bookingNoticeHours,
              items: const [
                DropdownMenuItem(value: 1, child: UiText(UiMessage.m_1_hour_f8b8883f0c)),
                DropdownMenuItem(value: 2, child: UiText(UiMessage.m_2_hours_9808e0ec3c)),
                DropdownMenuItem(value: 6, child: UiText(UiMessage.m_6_hours_4105ae3b8a)),
                DropdownMenuItem(value: 24, child: UiText(UiMessage.m_24_hours_f0514e8df8)),
              ],
              onChanged: (v) => setState(() => _bookingNoticeHours = v ?? 2),
            ),
            const SizedBox(height: Msg.s3),
            Row(children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    UiText(UiMessage.m_allow_rescheduling_375a56532a, style: ADText.rowName()),
                    UiText(
                      UiMessage.m_customer_can_move_the_booking_5c70a104f8,
                      style: ADText.preview(),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: Msg.s3),
              ZineToggle(
                value: _rescheduleAllowed,
                onChanged: (v) => setState(() => _rescheduleAllowed = v),
              ),
            ]),
            const SizedBox(height: Msg.s3),
            ZineField(
              controller: _preparationInstructions,
              label: uiCopy(UiMessage.m_preparation_instructions_optional_8587c70140),
              hint: uiCopy(UiMessage.m_what_should_the_customer_prepare_db42b5b82c),
              maxLines: 4,
              maxLength: 600,
              textCapitalization: TextCapitalization.sentences,
            ),
            const SizedBox(height: Msg.s2),
            UiText(
              UiMessage.m_if_the_customer_does_not_3638c31b36,
              style: ADText.preview(c: AD.textSecondary),
            ),
          ],
        ],
        const SizedBox(height: Msg.s4),
        const Divider(),
        const SizedBox(height: Msg.s2),
        UiText(UiMessage.m_pricing_extras_4f28a19ed4, style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s3),
        Row(children: [
          Expanded(child: UiText(UiMessage.m_early_bird_discount_31f28d32ed, style: ADText.rowName())),
          ZineToggle(
              value: _earlyBird,
              onChanged: (v) => setState(() => _earlyBird = v)),
        ]),
        if (_earlyBird) ...[
          const SizedBox(height: Msg.s3),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            SizedBox(
                width: 92,
                child: ZineField(
                    controller: _ebPct,
                    label: uiCopy(UiMessage.m_off_5e0aa53f41),
                    keyboardType: TextInputType.number)),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: ZinePressable(
                onTap: () async {
                  final d = await showDatePicker(
                      context: context,
                      initialDate: DateTime.now().add(const Duration(days: 3)),
                      firstDate: DateTime.now(),
                      lastDate: DateTime.now().add(const Duration(days: 180)));
                  if (d != null) setState(() => _ebEnds = d);
                },
                radius: BorderRadius.circular(Msg.rMd),
                padding: const EdgeInsets.symmetric(
                    horizontal: Msg.s4, vertical: Msg.s4),
                child: Row(children: [
                  PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold),
                      size: 16, color: AD.textPrimary),
                  const SizedBox(width: Msg.s2),
                  Flexible(
                    child: Text(
                        _ebEnds == null
                            ? uiCopy(UiMessage.m_until_3a163441ec)
                            : fmtWhen(_ebEnds!.millisecondsSinceEpoch),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.rowName()),
                  ),
                ]),
              ),
            ),
          ]),
        ],
        const SizedBox(height: Msg.s4),
        ZineField(
          controller: _promoCode,
          label: uiCopy(UiMessage.m_promo_code_optional_22be26ce4d),
          textCapitalization: TextCapitalization.characters,
          hint: uiCopy(UiMessage.m_avatok10_aef3d70f5d),
        ),
        const SizedBox(height: Msg.s3),
        Row(children: [
          Expanded(
              child: ZineField(
                  controller: _promoPct,
                  label: uiCopy(UiMessage.m_off_5e0aa53f41),
                  keyboardType: TextInputType.number)),
          const SizedBox(width: Msg.s3),
          Expanded(
              child: ZineField(
                  controller: _promoMax,
                  label: uiCopy(UiMessage.m_max_uses_e1085805b2),
                  keyboardType: TextInputType.number)),
        ]),
      ]);

  Future<void> _pickWhen() async {
    final d = await showDatePicker(
        context: context,
        initialDate: DateTime.now().add(const Duration(days: 1)),
        firstDate: DateTime.now(),
        lastDate: DateTime.now().add(const Duration(days: 180)));
    if (d == null || !mounted) return;
    final t = await showTimePicker(
        context: context, initialTime: const TimeOfDay(hour: 18, minute: 0));
    if (t == null) return;
    setState(() => _start = DateTime(d.year, d.month, d.day, t.hour, t.minute));
  }

  // ---- step 4: cover photos ----
  Widget _stepCovers() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 12, runSpacing: 12, children: [
          for (var i = 0; i < _coverUrls.length; i++)
            Stack(clipBehavior: Clip.none, children: [
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  border: Border.all(color: AD.borderCard, width: 1),
                  boxShadow: const <BoxShadow>[],
                ),
                clipBehavior: Clip.antiAlias,
                child: CoverImage(
                    url: _coverUrls[i], seed: i, width: 88, height: 88),
              ),
              Positioned(
                right: -7,
                top: -7,
                child: GestureDetector(
                  onTap: () => setState(() => _coverUrls.removeAt(i)),
                  child: Container(
                    width: 26,
                    height: 26,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: AD.danger,
                      border: Border.all(color: AD.borderCard, width: 2),
                    ),
                    child: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                        size: 14, color: Colors.white),
                  ),
                ),
              ),
            ]),
          if (_coverUrls.length < 5)
            GestureDetector(
              onTap: _pickCover,
              child: Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  border: Border.all(
                      color: AD.borderCard.withValues(alpha: 0.45), width: 2),
                ),
                child: _uploading
                    ? const Center(
                        child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: AD.primaryBadge)))
                    : PhosphorIcon(
                        PhosphorIcons.cameraPlus(PhosphorIconsStyle.bold),
                        size: 26,
                        color: AD.textSecondary),
              ),
            ),
        ]),
        const SizedBox(height: Msg.s3),
        UiText(
            UiMessage.m_1_5_photos_at_least_ab05245e97,
            style: ADText.preview()),
      ]);

  // ---- step 5: icons & flags ----
  Widget _stepIcons() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _country,
          label: uiCopy(UiMessage.m_country_code_e_g_in_247fee78b6),
          labelIcon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
          maxLength: 2,
          textCapitalization: TextCapitalization.characters,
          hint: uiCopy(UiMessage.m_in_fed1d872f6),
        ),
        const SizedBox(height: Msg.s4),
        ZineField(
          controller: _language,
          label: uiCopy(UiMessage.m_language_badge_optional_5f706837d9),
          labelIcon: PhosphorIcons.translate(PhosphorIconsStyle.bold),
          hint: uiCopy(UiMessage.m_e_g_hindi_0cce431ae7),
        ),
        const SizedBox(height: Msg.s4),
        Row(children: [
          Expanded(child: UiText(UiMessage.m_18_only_44ec1e9146, style: ADText.rowName())),
          ZineToggle(
              value: _adultsOnly,
              onChanged: (v) => setState(() => _adultsOnly = v)),
        ]),
        const SizedBox(height: Msg.s4),
        const Divider(),
        const SizedBox(height: Msg.s3),
        // Voice translation banner — lilac (AI/magic accent, §2).
        Container(
          padding: const EdgeInsets.all(Msg.s4),
          decoration: BoxDecoration(
            color: AD.micIdleBg,
            borderRadius: BorderRadius.circular(Msg.rLg),
            border: Border.all(color: AD.borderCard, width: 1),
            boxShadow: const <BoxShadow>[],
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      PhosphorIcon(PhosphorIcons.globe(PhosphorIconsStyle.bold),
                          size: 17, color: AD.textPrimary),
                      const SizedBox(width: Msg.s2),
                      Expanded(
                          child: UiText(UiMessage.m_voice_translation_available_598730c557,
                              style: ADText.threadName())),
                    ]),
                    const SizedBox(height: Msg.s2),
                    UiText(
                      UiMessage.m_attendees_can_hear_you_live_c6fd922785,
                      style: ADText.preview(c: AD.textPrimary),
                    ),
                  ]),
            ),
            const SizedBox(width: Msg.s3),
            ZineToggle(
                value: _translationEnabled,
                onChanged: (v) => setState(() => _translationEnabled = v)),
          ]),
        ),
        if (_translationEnabled) ...[
          const SizedBox(height: Msg.s4),
          ZineDropdown<String>(
            label: uiCopy(UiMessage.m_language_of_transmission_the_language_41b556549e),
            value: _spokenLang,
            hint: uiCopy(UiMessage.m_pick_a_language_c13d31e4b6),
            items: [
              for (final l in kTranslationLangs)
                DropdownMenuItem(value: l.code, child: Text(l.label)),
            ],
            onChanged: (v) => setState(() => _spokenLang = v),
          ),
        ],
      ]);

  // ---- step 6: preview & publish (A6 — REAL details widget with draft data) ----
  Widget _stepPreview() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        UiText(UiMessage.m_preview_what_buyers_see_897590425a, style: ADText.sectionLabel()),
        const SizedBox(height: Msg.s3),
        Container(
          height: 440,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Msg.rLg),
            border: Border.all(color: AD.borderCard, width: 1),
            boxShadow: const <BoxShadow>[],
          ),
          clipBehavior: Clip.antiAlias,
          child: ListingDetailView(card: _draftCard()),
        ),
      ]);
}

enum _StepState { active, done, todo }
