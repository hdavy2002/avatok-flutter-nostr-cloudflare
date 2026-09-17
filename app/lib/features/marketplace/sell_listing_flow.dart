
import '../../core/localization/ui_text.dart';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/cached_image.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import '../../core/marketplace_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/motion/motion.dart';
import '../identity/listing_liveness_gate.dart';
import '../identity/public_action_gate.dart' show isIdentityRequired;
import '../wallet/wallet_screen.dart';

/// AvaMarketplace P2 — buy/sell/social listing pipeline with the agent-mandate
/// + language step (Specs/AVAMARKETPLACE-FINAL-PROPOSAL.md). Self-contained so
/// it doesn't disturb the creator-service stepper. P3 adds the "Help me write"
/// AI buttons (wired here already), P7 adds the moderation gate at publish.
class SellListingFlow extends StatefulWidget {
  const SellListingFlow({super.key});
  @override
  State<SellListingFlow> createState() => _SellListingFlowState();
}

/// Currencies shown in the price picker — a marketplace listing is genuinely
/// multi-currency (see intent_theme.dart). [TOKENS-INR-DISPLAY-1] INR LEADS and
/// is the default: India is the only market (see the PRODUCT PIVOT in
/// CLAUDE.md) and the server already defaults to it
/// (`LISTING_DEFAULT_CURRENCY = "INR"`, worker/src/routes/listings.ts) — the app
/// was the last place still seeding every new listing as USD. ISO-4217 codes.
const List<String> kMarketCurrencies = [
  'INR', 'USD', 'EUR', 'GBP', 'RUB', 'AUD', 'CAD', 'AED', 'SGD', 'JPY',
  'CNY', 'BRL', 'ZAR', 'NGN', 'PKR', 'BDT', 'IDR', 'MXN', 'TRY', 'SAR',
];

/// Agent negotiation languages (subset; English is the cross-language fallback).
const List<String> kAgentLangs = [
  'English', 'Hindi', 'Spanish', 'French', 'Arabic', 'Portuguese', 'Bengali',
  'Urdu', 'Punjabi', 'Tamil', 'Russian', 'Mandarin', 'Indonesian', 'Turkish',
];

/// Fixed marketplace categories (users pick one — they can't create their own).
const List<String> kMarketCategories = [
  'Vehicles', 'Electronics', 'Mobiles', 'Computers', 'Furniture', 'Home & Garden',
  'Fashion', 'Property for sale', 'Property for rent', 'Jobs', 'Services', 'Books',
  'Sports & Hobbies', 'Pets', 'Kids & Baby', 'Business & Industrial', 'Other',
];

/// ISO-3166 alpha-2 → display name for the country picker. Full global list so a
/// seller can place their listing in any market (pic 2). Sorted by name in the UI.
const Map<String, String> kCountries = {
  'AF': 'Afghanistan', 'AL': 'Albania', 'DZ': 'Algeria', 'AR': 'Argentina', 'AU': 'Australia',
  'AT': 'Austria', 'BD': 'Bangladesh', 'BE': 'Belgium', 'BR': 'Brazil', 'BG': 'Bulgaria',
  'CA': 'Canada', 'CL': 'Chile', 'CN': 'China', 'CO': 'Colombia', 'HR': 'Croatia',
  'CZ': 'Czechia', 'DK': 'Denmark', 'EG': 'Egypt', 'FI': 'Finland', 'FR': 'France',
  'DE': 'Germany', 'GH': 'Ghana', 'GR': 'Greece', 'HK': 'Hong Kong', 'HU': 'Hungary',
  'IN': 'India', 'ID': 'Indonesia', 'IR': 'Iran', 'IQ': 'Iraq', 'IE': 'Ireland',
  'IL': 'Israel', 'IT': 'Italy', 'JP': 'Japan', 'JO': 'Jordan', 'KE': 'Kenya',
  'KW': 'Kuwait', 'MY': 'Malaysia', 'MX': 'Mexico', 'MA': 'Morocco', 'NP': 'Nepal',
  'NL': 'Netherlands', 'NZ': 'New Zealand', 'NG': 'Nigeria', 'NO': 'Norway', 'OM': 'Oman',
  'PK': 'Pakistan', 'PH': 'Philippines', 'PL': 'Poland', 'PT': 'Portugal', 'QA': 'Qatar',
  'RO': 'Romania', 'RU': 'Russia', 'SA': 'Saudi Arabia', 'RS': 'Serbia', 'SG': 'Singapore',
  'ZA': 'South Africa', 'KR': 'South Korea', 'ES': 'Spain', 'LK': 'Sri Lanka', 'SE': 'Sweden',
  'CH': 'Switzerland', 'TW': 'Taiwan', 'TZ': 'Tanzania', 'TH': 'Thailand', 'TR': 'Türkiye',
  'UG': 'Uganda', 'UA': 'Ukraine', 'AE': 'United Arab Emirates', 'GB': 'United Kingdom',
  'US': 'United States', 'VN': 'Vietnam', 'ZW': 'Zimbabwe',
};

/// Country codes sorted by display name for the dropdown.
final List<String> kCountryCodes = kCountries.keys.toList()
  ..sort((a, b) => kCountries[a]!.compareTo(kCountries[b]!));

String flagFor(String cc) {
  if (cc.length != 2) return '🌍';
  final up = cc.toUpperCase();
  return String.fromCharCode(0x1F1E6 + up.codeUnitAt(0) - 65) +
      String.fromCharCode(0x1F1E6 + up.codeUnitAt(1) - 65);
}

class _SellListingFlowState extends State<SellListingFlow> {
  int _step = 0;
  String _type = 'sell'; // sell | buy | social
  String _socialSub = 'roommate'; // dating | matrimony | roommate | events

  final _title = TextEditingController();
  final _desc = TextEditingController();
  String _category = 'Vehicles';
  // Default to the device's country so the listing lands in the seller's market.
  String _country = (() {
    final cc = WidgetsBinding.instance.platformDispatcher.locale.countryCode?.toUpperCase();
    return (cc != null && kCountries.containsKey(cc)) ? cc : 'US';
  })();
  final _location = TextEditingController();
  final _price = TextEditingController();
  String _currency = kMarketCurrencies.first;
  final _agentInstr = TextEditingController();
  String _agentLang = 'English';
  final _accent = TextEditingController();
  int _expiryDays = 30;
  final List<String> _coverUrls = [];
  bool _uploading = false;

  bool _busy = false;
  bool _aiBusy = false;
  String? _error;
  String? _draftId;
  ListingFeeQuote? _feeQuote;
  bool _feeLoading = false;
  bool _needsTopUp = false;

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

  /// Zine-style input: white fill, 2px black border, rounded — matches the
  /// AvaTOK design system (bordered cards + lime buttons). Labels are rendered
  /// ABOVE each field at a readable size (the floating-label form was tiny).
  InputDecoration _box({String? hint}) => InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(color: AD.placeholderOnWhite),
        filled: true,
        fillColor: AD.inputField,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s4),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.borderControl, width: 1)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.borderControl, width: 1)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.iconSearch, width: 1)),
      );

  /// A big, readable field label sitting above its input.
  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s2, top: 2),
        child: Text(text, style: TextStyle(fontFamily: ADText.family, fontSize: 15, fontWeight: FontWeight.w700, color: AD.textPrimary)),
      );

  /// Label + field stacked — replaces the tiny floating labels (pic 1).
  Widget _field(String label, Widget input) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [_label(label), input]);

  String get _exampleInstruction {
    switch (_type) {
      case 'buy':
        return 'You represent me buying a used road bike. My max is the price set, must be under 5 yrs old. Be polite, ask about condition, don’t reveal my max early.';
      case 'social':
        return 'You represent me (${_socialSub}). Share that I value honesty and family; ask about their background and expectations; only connect us if it’s a genuine match.';
      default:
        return 'You represent me selling a 2018 Honda Civic. Floor is the price set, aim higher. Mention low mileage + full service history. Pickup this week only. Be polite, firm on price.';
    }
  }

  Future<void> _helpMeWrite(String want, TextEditingController target) async {
    setState(() => _aiBusy = true);
    Analytics.capture('listing_ai_assist_used', {'kind': _type, 'want': want});
    final text = await MarketplaceApi.aiAssist(want: want, kind: _type, fields: _fields());
    if (!mounted) return;
    setState(() {
      _aiBusy = false;
      if (text != null) target.text = text;
      else _error = 'Could not draft text right now — try again.';
    });
  }

  Map<String, dynamic> _fields() => {
        'market_type': _type,
        if (_type == 'social') 'social_sub': _socialSub,
        'title': _title.text.trim(),
        'description': _desc.text.trim(),
        'category': _category,
        'country': _country,
        'location': _location.text.trim(),
        'price_amount': int.tryParse(_price.text.trim()) ?? 0,
        'price_currency': _currency,
        'agent_instructions': _agentInstr.text.trim(),
        'agent_lang': _agentLang,
        'agent_voice_persona': _accent.text.trim(),
        'expiry_days': _expiryDays,
        'cover_media': [for (final u in _coverUrls) {'type': 'image', 'url': u}],
      };

  /// Required-field gate per step — Continue/Submit stays disabled until the
  /// step is complete (pic 6). Photos require at least one image; social budget
  /// is the one optional price.
  bool _stepComplete(int step) {
    switch (step) {
      case 0:
        return true; // type always has a value
      case 1:
        return _title.text.trim().isNotEmpty &&
            _desc.text.trim().isNotEmpty &&
            _location.text.trim().isNotEmpty;
      case 2:
        return _type == 'social' || (int.tryParse(_price.text.trim()) ?? 0) > 0;
      case 3:
        return _agentInstr.text.trim().isNotEmpty;
      case 4:
        return _coverUrls.isNotEmpty;
      default:
        return true;
    }
  }

  String _stepHint(int step) {
    switch (step) {
      case 1: return uiCopy(UiMessage.m_fill_in_title_description_and_d8bbdd9d41);
      case 2: return uiCopy(UiMessage.m_enter_a_price_to_continue_8ac7258ef3);
      case 3: return uiCopy(UiMessage.m_tell_your_agent_how_to_9ff4c12881);
      case 4: return uiCopy(UiMessage.m_add_at_least_one_photo_84b6e02b51);
      default: return '';
    }
  }

  Future<void> _prepareReview() async {
    if (_draftId == null) {
      _draftId = await ListingsApi.createDraft(_type, _fields());
    } else {
      await ListingsApi.update(_draftId!, _fields());
    }
    if (_draftId != null) await _refreshFeeQuote();
  }

  Future<void> _refreshFeeQuote() async {
    setState(() => _feeLoading = true);
    final quote = await ListingsApi.feeQuote(listingId: _draftId);
    if (!mounted) return;
    setState(() {
      _feeQuote = quote;
      _feeLoading = false;
    });
    Analytics.capture('listing_fee_quote_viewed', {
      'has_quote': quote != null,
      'listing_id': _draftId ?? '',
    });
  }

  Future<void> _openWallet() async {
    await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const WalletScreen()));
    if (!mounted) return;
    setState(() => _needsTopUp = false);
    await _refreshFeeQuote();
  }

  ListingFeeQuote? _feeFromResponse(Map<String, dynamic> res) {
    final raw = res['fee'] ?? res['fee_quote'] ?? res['quote'];
    if (raw is Map) return ListingFeeQuote.fromJson(raw.cast<String, dynamic>());
    if (res.containsKey('fee_tokens') || res.containsKey('amount')) {
      return ListingFeeQuote.fromJson(res);
    }
    return null;
  }

  String _successFeeText(Map<String, dynamic> res) {
    final fee = _feeFromResponse(res) ?? _feeQuote;
    if (fee == null || fee.isFree) return uiCopy(UiMessage.m_listing_submitted_for_review_eb65e75dfa);
    final balance = fee.balance == null ? '' : uiCopy(UiMessage.m_balance_value1_tokens_70adc45d3f, {'value1': (fee.balance).toString()});
    return uiCopy(UiMessage.m_listing_submitted_for_review_value1_dc102a7148, {'value1': (fee.amount).toString(), 'balance': (balance).toString()});
  }

  Widget _feePanel() {
    final quote = _feeQuote;
    final insufficient = _needsTopUp || quote?.insufficient == true;
    final copy = quote == null
        ? uiCopy(UiMessage.m_live_publishing_fee_is_unavailable_541aa73aaa)
        : quote.isFree
            ? uiCopy(UiMessage.m_free_30_day_entitlement_available_814878506b, {'value1': (quote.freeRemaining == null ? '' : uiCopy(UiMessage.m_count_free_slot_s_remaining_d986900f87, {'count': (quote.freeRemaining).toString()})).toString()})
            : uiCopy(UiMessage.m_publishing_fee_value1_tokens_value2_8603314523, {'value1': (quote.amount).toString(), 'value2': (quote.balance == null ? '' : uiCopy(UiMessage.m_balance_amount_22c9553235, {'amount': (quote.balance).toString()})).toString()});
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: Msg.s3),
      padding: const EdgeInsets.all(Msg.s3),
      decoration: BoxDecoration(
        color: insufficient ? AD.danger.withOpacity(.08) : AD.bg,
        border: Border.all(color: insufficient ? AD.danger : AD.borderControl),
        borderRadius: Msg.brMd,
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(copy, style: ADText.preview(c: AD.textSecondary))),
          if (_feeLoading)
            const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2)),
        ]),
        if (insufficient) ...[
          const SizedBox(height: Msg.s2),
          UiText(UiMessage.m_your_balance_is_too_low_dc445ea630,
              style: ADText.preview(c: AD.danger)),
          const SizedBox(height: Msg.s2),
          TextButton(onPressed: _openWallet, child: const UiText(UiMessage.m_open_wallet_762a16c9c7)),
        ],
      ]),
    );
  }

  /// `ListingsApi.publish` response includes fee/status metadata on success or
  /// a decoded error body on failure; adapt it to
  /// `isIdentityRequired(statusCode, body)` instead of re-implementing the match.
  int _statusOf(Map<String, dynamic> res) => (res['status'] as num?)?.toInt() ?? 0;

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    _needsTopUp = false;
    final sw = Stopwatch()..start();
    Analytics.capture('listing_submitted', {
      'type': _type, 'category': _category,
      'price_amount': int.tryParse(_price.text.trim()) ?? 0, 'price_currency': _currency,
    });
    // P7 safety precheck: text moderation + PII strip BEFORE the listing is saved.
    final pc = await MarketplaceApi.precheck(title: _title.text.trim(), description: _desc.text.trim());
    if (pc['ok'] != true) {
      Analytics.capture('listing_rejected', {'type': _type, 'reason': pc['reason']});
      setState(() { _busy = false; _error = pc['reason']?.toString() ?? 'Your listing was rejected — please revise it.'; });
      return;
    }
    final cleaned = pc['cleaned_description']?.toString();
    if (cleaned != null && cleaned.isNotEmpty) _desc.text = cleaned;
    final id = _draftId ?? await ListingsApi.createDraft(_type, _fields());
    if (id == null) {
      setState(() { _busy = false; _error = 'Could not save your listing.'; });
      return;
    }
    _draftId = id;
    await ListingsApi.update(id, _fields());
    var res = await ListingsApi.publish(id);
    // Fallback: the server gate returns 403 {error:'identity_required'} when the
    // seller has no valid (<90 day) liveness pass. The old 'phone_required' /
    // 'liveness_required' strings are DEAD — phone verification was removed
    // app-wide on 2026-07-10 and creating a listing became a PUBLIC ACTION
    // (see identity/public_action_gate.dart). Matching them meant this friendly
    // path never fired and the seller saw the raw error string instead.
    // Don't show the raw string — run consent→liveness and, on PASS, retry
    // publish once. On fail, a friendly message.
    if (isIdentityRequired(_statusOf(res), jsonEncode(res))) {
      if (!mounted) return;
      final passed = await ensureListingLiveness(context);
      if (!mounted) return;
      if (passed) {
        res = await ListingsApi.publish(id); // retry once, now verified
      } else {
        setState(() { _busy = false; _error = 'You need to verify you\'re a real person to publish a listing.'; });
        return;
      }
    }
    if (!mounted) return;
    setState(() => _busy = false);
    if (res['ok'] == true) {
      Analytics.capture('listing_published', {'type': _type, 'submit_ms': sw.elapsedMilliseconds});
      if (mounted) {
        showAdToast(context, message: _successFeeText(res));
        Navigator.of(context).maybePop();
      }
    } else if (isIdentityRequired(_statusOf(res), jsonEncode(res))) {
      // Retry still gated (e.g. server hadn't propagated) — friendly message.
      setState(() => _error = 'You need to verify you\'re a real person to publish a listing.');
    } else {
      // Identity gate (eligibility) / moderation / daily-cap rejections surface here.
      final reason = res['error']?.toString() ?? res['reason']?.toString();
      if (_statusOf(res) == 402 ||
          reason == 'insufficient_tokens' ||
          reason == 'insufficient_balance') {
        _feeQuote = _feeFromResponse(res) ?? _feeQuote;
        setState(() {
          _needsTopUp = true;
          _error = 'You need more Tokens to publish. Your draft is safe.';
        });
      } else {
        setState(() => _error = reason ?? 'Could not publish.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        title: UiText(UiMessage.m_create_listing_815d30caa6, style: ADText.appTitle()),
      ),
      body: Theme(
        data: Theme.of(context).copyWith(
          colorScheme: Theme.of(context).colorScheme.copyWith(primary: AD.primaryBadge),
        ),
        child: Stepper(
        currentStep: _step,
        onStepContinue: () {
          if (_step < 5) {
            final next = _step + 1;
            setState(() => _step = next);
            if (next == 5) _prepareReview();
          } else {
            _submit();
          }
        },
        onStepCancel: () => setState(() => _step = _step > 0 ? _step - 1 : 0),
        controlsBuilder: (context, details) {
          final complete = _stepComplete(_step);
          return Padding(
            padding: const EdgeInsets.only(top: Msg.s3),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                AdButton(
                  label: _step < 5 ? uiCopy(UiMessage.m_continue_31fbef1625) : (_busy ? uiCopy(UiMessage.m_submitting_49195f559e) : uiCopy(UiMessage.m_submit_listing_525f0ca85f)),
                  loading: _busy && _step >= 5,
                  onPressed: (_busy || !complete) ? null : details.onStepContinue,
                ),
                const SizedBox(width: Msg.s2),
                if (_step > 0) TextButton(onPressed: details.onStepCancel,
                    child: UiText(UiMessage.m_back_76900f1bfd, style: TextStyle(color: AD.textSecondary, fontFamily: ADText.family, fontWeight: FontWeight.w600))),
              ]),
              if (!complete && _stepHint(_step).isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: Msg.s2),
                  child: Text(_stepHint(_step), style: TextStyle(fontFamily: ADText.family, fontSize: 12, color: AD.textTertiary)),
                ),
            ]),
          );
        },
        steps: [
          Step(
            title: UiText(UiMessage.m_type_baaddf70fb, style: ADText.rowName()),
            isActive: _step >= 0,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SegmentedButton<String>(
                style: SegmentedButton.styleFrom(
                  backgroundColor: AD.card,
                  foregroundColor: AD.textSecondary,
                  selectedBackgroundColor: AD.primaryBadge,
                  selectedForegroundColor: Colors.white,
                  side: BorderSide(color: AD.borderControl, width: 1),
                  textStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600),
                ),
                segments: const [
                  ButtonSegment(value: 'sell', label: UiText(UiMessage.m_selling_05e9f7818f)),
                  ButtonSegment(value: 'buy', label: UiText(UiMessage.m_buying_e87c8e7d44)),
                  ButtonSegment(value: 'social', label: UiText(UiMessage.m_social_f1b7505afa)),
                ],
                selected: {_type},
                onSelectionChanged: (s) => setState(() => _type = s.first),
              ),
              if (_type == 'social') ...[
                const SizedBox(height: Msg.s4),
                _field('Social type', DropdownButtonFormField<String>(
                  value: _socialSub,
                  isExpanded: true,
                  decoration: _box(),
                  items: const [
                    DropdownMenuItem(value: 'dating', child: UiText(UiMessage.m_dating_21a6b5a12e)),
                    DropdownMenuItem(value: 'matrimony', child: UiText(UiMessage.m_matrimony_d09d4ff7fc)),
                    DropdownMenuItem(value: 'roommate', child: UiText(UiMessage.m_roommate_b0bcae2bd0)),
                    DropdownMenuItem(value: 'events', child: UiText(UiMessage.m_community_events_f8dbf4962b)),
                  ],
                  onChanged: (v) => setState(() => _socialSub = v ?? 'roommate'),
                )),
              ],
            ]),
          ),
          Step(
            title: UiText(UiMessage.m_details_45989de49f, style: ADText.rowName()),
            isActive: _step >= 1,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _field('Title', TextField(controller: _title, onChanged: (_) => setState(() {}), decoration: _box(hint: uiCopy(UiMessage.m_what_are_you_listing_02b62320b6)))),
              const SizedBox(height: Msg.s4),
              _field('Description', TextField(controller: _desc, maxLines: 4, onChanged: (_) => setState(() {}), decoration: _box(hint: uiCopy(UiMessage.m_add_the_details_buyers_need_4befd82439)))),
              const SizedBox(height: Msg.s4),
              _field('Category', DropdownButtonFormField<String>(
                value: _category,
                isExpanded: true,
                decoration: _box(),
                items: [for (final c in kMarketCategories) DropdownMenuItem(value: c, child: Text(c))],
                onChanged: (v) => setState(() => _category = v ?? kMarketCategories.first),
              )),
              const SizedBox(height: Msg.s4),
              _field('Country', DropdownButtonFormField<String>(
                value: _country,
                isExpanded: true,
                decoration: _box(),
                items: [
                  for (final cc in kCountryCodes)
                    DropdownMenuItem(value: cc, child: Text('${flagFor(cc)}  ${kCountries[cc]}')),
                ],
                onChanged: (v) => setState(() => _country = v ?? _country),
              )),
              const SizedBox(height: Msg.s4),
              _field('Location', TextField(controller: _location, onChanged: (_) => setState(() {}), decoration: _box(hint: uiCopy(UiMessage.m_city_or_area_3d4dee46f8)))),
            ]),
          ),
          Step(
            title: UiText(UiMessage.m_price_93c91c851e, style: ADText.rowName()),
            isActive: _step >= 2,
            content: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: _field(_type == 'social' ? 'Budget (optional)' : 'Price', TextField(
                  controller: _price,
                  keyboardType: TextInputType.number,
                  onChanged: (_) => setState(() {}),
                  decoration: _box(hint: '0'),
                )),
              ),
              const SizedBox(width: Msg.s3),
              SizedBox(
                width: 120,
                child: _field('Currency', DropdownButtonFormField<String>(
                  value: _currency,
                  isExpanded: true,
                  decoration: _box(),
                  items: [for (final c in kMarketCurrencies) DropdownMenuItem(value: c, child: Text(c))],
                  onChanged: (v) => setState(() => _currency = v ?? kMarketCurrencies.first),
                )),
              ),
            ]),
          ),
          Step(
            title: UiText(UiMessage.m_your_agent_1ffbc15d64, style: ADText.rowName()),
            isActive: _step >= 3,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _label('Tell your agent how to negotiate for you'),
              TextField(controller: _agentInstr, maxLines: 4, onChanged: (_) => setState(() {}), decoration: _box(hint: uiCopy(UiMessage.m_your_price_stance_key_facts_56bc4d7ba8))),
              const SizedBox(height: Msg.s1),
              Row(children: [
                TextButton.icon(
                  onPressed: _aiBusy ? null : () => _helpMeWrite('instructions', _agentInstr),
                  icon: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.regular), size: 18, color: AD.iconAccent),
                  label: Text(_aiBusy ? uiCopy(UiMessage.m_writing_e52fe93bbb) : uiCopy(UiMessage.m_help_me_write_c5c57a17c8),
                      style: TextStyle(color: AD.iconVideo, fontFamily: ADText.family, fontWeight: FontWeight.w600)),
                ),
              ]),
              Container(
                padding: const EdgeInsets.all(Msg.s2),
                decoration: BoxDecoration(color: AD.card, borderRadius: BorderRadius.circular(AD.rStatCard)),
                child: UiText(UiMessage.m_example_exampleinstruction_552c6b5c28, params: {'exampleInstruction': (_exampleInstruction).toString()}, style: TextStyle(fontFamily: ADText.family, fontSize: 12, color: AD.textSecondary)),
              ),
              const SizedBox(height: Msg.s4),
              _field('Agent language', DropdownButtonFormField<String>(
                value: _agentLang,
                isExpanded: true,
                decoration: _box(),
                items: [for (final l in kAgentLangs) DropdownMenuItem(value: l, child: Text(l))],
                onChanged: (v) => setState(() => _agentLang = v ?? 'English'),
              )),
              const SizedBox(height: Msg.s4),
              _field('Accent / persona (optional)', TextField(controller: _accent,
                  decoration: _box(hint: uiCopy(UiMessage.m_e_g_warm_punjabi_accent_37b7afea92)))),
              const SizedBox(height: Msg.s1),
              UiText(UiMessage.m_if_the_other_agent_doesn_20723f7b9f,
                  style: TextStyle(fontFamily: ADText.family, fontSize: 11, color: AD.textTertiary)),
            ]),
          ),
          Step(
            title: UiText(UiMessage.m_photos_5e3147ab51, style: ADText.rowName()),
            isActive: _step >= 4,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              UiText(UiMessage.m_add_photos_max_5_55d924e1a1, style: TextStyle(fontFamily: ADText.family, fontSize: 14, fontWeight: FontWeight.w600, color: AD.textPrimary)),
              const SizedBox(height: Msg.s2),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (var i = 0; i < _coverUrls.length; i++)
                  Stack(children: [
                    CachedImage(_coverUrls[i], width: 84, height: 84, radius: BorderRadius.circular(Msg.rSm)),
                    Positioned(
                      right: 0, top: 0,
                      child: GestureDetector(
                        onTap: () => setState(() => _coverUrls.removeAt(i)),
                        child: Container(
                          decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                          padding: const EdgeInsets.all(2),
                          child: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 14, color: Colors.white)),
                      ),
                    ),
                  ]),
                if (_coverUrls.length < 5)
                  GestureDetector(
                    onTap: _uploading ? null : _pickCover,
                    child: Container(
                      width: 84, height: 84,
                      decoration: BoxDecoration(
                          color: AD.card,
                          border: Border.all(color: AD.borderControl), borderRadius: BorderRadius.circular(Msg.rSm)),
                      child: Center(
                        child: _uploading
                            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                            : PhosphorIcon(PhosphorIcons.cameraPlus(PhosphorIconsStyle.regular), color: AD.textSecondary)),
                    ),
                  ),
              ]),
            ]),
          ),
          Step(
            title: UiText(UiMessage.m_review_aff0766a52, style: ADText.rowName()),
            isActive: _step >= 5,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              UiText(UiMessage.m_listing_expires_in_0c976ca62c, style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600, color: AD.textPrimary)),
              const SizedBox(height: Msg.s2),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final d in const [1, 5, 10, 20, 30])
                  ChoiceChip(
                    label: UiText(UiMessage.m_d_day_value2_bf55c33dbc, params: {'d': (d).toString(), 'value2': (d == 1 ? '' : uiCopy(UiMessage.m_s_043a718774)).toString()}),
                    labelStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                        color: _expiryDays == d ? Colors.white : AD.textSecondary),
                    selected: _expiryDays == d,
                    showCheckmark: false,
                    onSelected: (_) async {
                      setState(() => _expiryDays = d);
                      if (_draftId != null) {
                        await ListingsApi.update(_draftId!, _fields());
                        await _refreshFeeQuote();
                      }
                    },
                    shape: RoundedRectangleBorder(
                        borderRadius: Msg.brPill,
                        side: BorderSide(color: AD.borderControl, width: 1)),
                    backgroundColor: AD.card,
                    selectedColor: AD.primaryBadge,
                  ),
              ]),
              _feePanel(),
              const SizedBox(height: Msg.s3),
              if (_error != null)
                Padding(padding: const EdgeInsets.only(top: Msg.s2),
                    child: AdErrorMsg(_error!)),
            ]),
          ),
        ],
        ),
      ),
    );
  }
}
