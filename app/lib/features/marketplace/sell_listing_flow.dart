import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import '../../core/marketplace_api.dart';

/// AvaMarketplace P2 — buy/sell/social listing pipeline with the agent-mandate
/// + language step (Specs/AVAMARKETPLACE-FINAL-PROPOSAL.md). Self-contained so
/// it doesn't disturb the creator-service stepper. P3 adds the "Help me write"
/// AI buttons (wired here already), P7 adds the moderation gate at publish.
class SellListingFlow extends StatefulWidget {
  const SellListingFlow({super.key});
  @override
  State<SellListingFlow> createState() => _SellListingFlowState();
}

/// Currencies shown in the price picker — global, not USD-only. ISO-4217 codes.
const List<String> kMarketCurrencies = [
  'USD', 'EUR', 'GBP', 'INR', 'RUB', 'AUD', 'CAD', 'AED', 'SGD', 'JPY',
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

class _SellListingFlowState extends State<SellListingFlow> {
  int _step = 0;
  String _type = 'sell'; // sell | buy | social
  String _socialSub = 'roommate'; // dating | matrimony | roommate | events

  final _title = TextEditingController();
  final _desc = TextEditingController();
  String _category = 'Vehicles';
  final _location = TextEditingController();
  final _price = TextEditingController();
  String _currency = 'USD';
  final _agentInstr = TextEditingController();
  String _agentLang = 'English';
  final _accent = TextEditingController();
  int _expiryDays = 30;
  final List<String> _coverUrls = [];
  bool _uploading = false;

  bool _busy = false;
  bool _aiBusy = false;
  String? _error;

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
  /// AvaTOK design system (bordered cards + lime buttons).
  InputDecoration _box(String label, {String? hint}) => InputDecoration(
        labelText: label,
        hintText: hint,
        filled: true,
        fillColor: Colors.white,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        floatingLabelBehavior: FloatingLabelBehavior.always,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Colors.black, width: 2)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Colors.black, width: 2)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Colors.black, width: 2)),
      );

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
        'location': _location.text.trim(),
        'price_amount': int.tryParse(_price.text.trim()) ?? 0,
        'price_currency': _currency,
        'agent_instructions': _agentInstr.text.trim(),
        'agent_lang': _agentLang,
        'agent_voice_persona': _accent.text.trim(),
        'expiry_days': _expiryDays,
        'cover_media': [for (final u in _coverUrls) {'type': 'image', 'url': u}],
      };

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
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
    final id = await ListingsApi.createDraft(_type, _fields());
    if (id == null) {
      setState(() { _busy = false; _error = 'Could not save your listing.'; });
      return;
    }
    final res = await ListingsApi.publish(id);
    if (!mounted) return;
    setState(() => _busy = false);
    if (res.isEmpty) {
      Analytics.capture('listing_published', {'type': _type});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Listing submitted for review.')));
        Navigator.of(context).maybePop();
      }
    } else {
      // Identity gate (eligibility) / moderation / daily-cap rejections surface here.
      setState(() => _error = res['error']?.toString() ?? res['reason']?.toString() ?? 'Could not publish.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create listing')),
      body: Stepper(
        currentStep: _step,
        onStepContinue: () {
          if (_step < 5) {
            setState(() => _step++);
          } else {
            _submit();
          }
        },
        onStepCancel: () => setState(() => _step = _step > 0 ? _step - 1 : 0),
        controlsBuilder: (context, details) => Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Row(children: [
            FilledButton(
              onPressed: _busy ? null : details.onStepContinue,
              child: Text(_step < 5 ? 'Continue' : (_busy ? 'Submitting…' : 'Submit listing')),
            ),
            const SizedBox(width: 8),
            if (_step > 0) TextButton(onPressed: details.onStepCancel, child: const Text('Back')),
          ]),
        ),
        steps: [
          Step(
            title: const Text('Type'),
            isActive: _step >= 0,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'sell', label: Text('Selling')),
                  ButtonSegment(value: 'buy', label: Text('Buying')),
                  ButtonSegment(value: 'social', label: Text('Social')),
                ],
                selected: {_type},
                onSelectionChanged: (s) => setState(() => _type = s.first),
              ),
              if (_type == 'social') ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: _socialSub,
                  isExpanded: true,
                  decoration: _box('Social type'),
                  items: const [
                    DropdownMenuItem(value: 'dating', child: Text('Dating')),
                    DropdownMenuItem(value: 'matrimony', child: Text('Matrimony')),
                    DropdownMenuItem(value: 'roommate', child: Text('Roommate')),
                    DropdownMenuItem(value: 'events', child: Text('Community events')),
                  ],
                  onChanged: (v) => setState(() => _socialSub = v ?? 'roommate'),
                ),
              ],
            ]),
          ),
          Step(
            title: const Text('Details'),
            isActive: _step >= 1,
            content: Column(children: [
              TextField(controller: _title, decoration: _box('Title')),
              const SizedBox(height: 12),
              TextField(controller: _desc, maxLines: 4, decoration: _box('Description')),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                value: _category,
                isExpanded: true,
                decoration: _box('Category'),
                items: [for (final c in kMarketCategories) DropdownMenuItem(value: c, child: Text(c))],
                onChanged: (v) => setState(() => _category = v ?? kMarketCategories.first),
              ),
              const SizedBox(height: 12),
              TextField(controller: _location, decoration: _box('Location', hint: 'City or area')),
            ]),
          ),
          Step(
            title: const Text('Price'),
            isActive: _step >= 2,
            content: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: TextField(
                  controller: _price,
                  keyboardType: TextInputType.number,
                  decoration: _box(_type == 'social' ? 'Budget (optional)' : 'Price'),
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: 116,
                child: DropdownButtonFormField<String>(
                  value: _currency,
                  isExpanded: true,
                  decoration: _box('Currency'),
                  items: [for (final c in kMarketCurrencies) DropdownMenuItem(value: c, child: Text(c))],
                  onChanged: (v) => setState(() => _currency = v ?? 'USD'),
                ),
              ),
            ]),
          ),
          Step(
            title: const Text('Your agent'),
            isActive: _step >= 3,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Tell your agent how to negotiate on your behalf:'),
              const SizedBox(height: 6),
              TextField(controller: _agentInstr, maxLines: 4, decoration: _box('Agent instructions')),
              const SizedBox(height: 4),
              Row(children: [
                TextButton.icon(
                  onPressed: _aiBusy ? null : () => _helpMeWrite('instructions', _agentInstr),
                  icon: const Icon(Icons.auto_awesome, size: 18),
                  label: Text(_aiBusy ? 'Writing…' : 'Help me write'),
                ),
              ]),
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: const Color(0x0A000000), borderRadius: BorderRadius.circular(6)),
                child: Text('Example: $_exampleInstruction', style: const TextStyle(fontSize: 12)),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                value: _agentLang,
                isExpanded: true,
                decoration: _box('Agent language'),
                items: [for (final l in kAgentLangs) DropdownMenuItem(value: l, child: Text(l))],
                onChanged: (v) => setState(() => _agentLang = v ?? 'English'),
              ),
              const SizedBox(height: 12),
              TextField(controller: _accent,
                  decoration: _box('Accent / persona (optional)', hint: 'e.g. warm, Punjabi accent')),
              const SizedBox(height: 4),
              const Text('If the other agent doesn’t speak your language, both fall back to English with your accent.',
                  style: TextStyle(fontSize: 11, color: Colors.black54)),
            ]),
          ),
          Step(
            title: const Text('Photos'),
            isActive: _step >= 4,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Add up to 5 photos (optional).', style: TextStyle(fontSize: 12, color: Colors.black54)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (var i = 0; i < _coverUrls.length; i++)
                  Stack(children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.network(_coverUrls[i], width: 84, height: 84, fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Container(
                              width: 84, height: 84, color: const Color(0x11000000),
                              child: const Icon(Icons.broken_image))),
                    ),
                    Positioned(
                      right: 0, top: 0,
                      child: GestureDetector(
                        onTap: () => setState(() => _coverUrls.removeAt(i)),
                        child: Container(
                          decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                          padding: const EdgeInsets.all(2),
                          child: const Icon(Icons.close, size: 14, color: Colors.white)),
                      ),
                    ),
                  ]),
                if (_coverUrls.length < 5)
                  GestureDetector(
                    onTap: _uploading ? null : _pickCover,
                    child: Container(
                      width: 84, height: 84,
                      decoration: BoxDecoration(
                          border: Border.all(color: Colors.black26), borderRadius: BorderRadius.circular(8)),
                      child: Center(
                        child: _uploading
                            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.add_a_photo_outlined)),
                    ),
                  ),
              ]),
            ]),
          ),
          Step(
            title: const Text('Review'),
            isActive: _step >= 5,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Listing expires in:', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final d in const [1, 5, 10, 20, 30])
                  ChoiceChip(
                    label: Text('$d day${d == 1 ? '' : 's'}'),
                    selected: _expiryDays == d,
                    onSelected: (_) => setState(() => _expiryDays = d),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(100),
                        side: const BorderSide(color: Colors.black, width: 2)),
                    backgroundColor: Colors.white,
                    selectedColor: const Color(0xFFC4F24D),
                  ),
              ]),
              const SizedBox(height: 12),
              if (_error != null)
                Padding(padding: const EdgeInsets.only(top: 8),
                    child: Text(_error!, style: const TextStyle(color: Colors.red))),
            ]),
          ),
        ],
      ),
    );
  }
}
