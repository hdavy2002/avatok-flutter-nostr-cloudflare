import 'package:flutter/material.dart';

import '../../core/analytics.dart';
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

class _SellListingFlowState extends State<SellListingFlow> {
  int _step = 0;
  String _type = 'sell'; // sell | buy | social
  String _socialSub = 'roommate'; // dating | matrimony | roommate | events

  final _title = TextEditingController();
  final _desc = TextEditingController();
  final _category = TextEditingController();
  final _location = TextEditingController();
  final _price = TextEditingController();
  String _currency = 'USD';
  final _agentInstr = TextEditingController();
  String _agentLang = 'English';
  final _accent = TextEditingController();
  int _expiryDays = 30;

  bool _busy = false;
  bool _aiBusy = false;
  String? _error;

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
        'category': _category.text.trim(),
        'location': _location.text.trim(),
        'price_amount': int.tryParse(_price.text.trim()) ?? 0,
        'price_currency': _currency,
        'agent_instructions': _agentInstr.text.trim(),
        'agent_lang': _agentLang,
        'agent_voice_persona': _accent.text.trim(),
        'expiry_days': _expiryDays,
      };

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    Analytics.capture('listing_submitted', {
      'type': _type, 'category': _category.text.trim(),
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
          if (_step < 4) {
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
              child: Text(_step < 4 ? 'Continue' : (_busy ? 'Submitting…' : 'Submit listing')),
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
                  decoration: const InputDecoration(labelText: 'Social type'),
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
              TextField(controller: _title, decoration: const InputDecoration(labelText: 'Title')),
              TextField(controller: _desc, maxLines: 4, decoration: const InputDecoration(labelText: 'Description')),
              TextField(controller: _category, decoration: const InputDecoration(labelText: 'Category')),
              TextField(controller: _location, decoration: const InputDecoration(labelText: 'Location')),
            ]),
          ),
          Step(
            title: const Text('Price'),
            isActive: _step >= 2,
            content: Row(children: [
              Expanded(
                child: TextField(
                  controller: _price,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(labelText: _type == 'social' ? 'Budget (optional)' : 'Price'),
                ),
              ),
              const SizedBox(width: 12),
              DropdownButton<String>(
                value: _currency,
                items: [for (final c in kMarketCurrencies) DropdownMenuItem(value: c, child: Text(c))],
                onChanged: (v) => setState(() => _currency = v ?? 'USD'),
              ),
            ]),
          ),
          Step(
            title: const Text('Your agent'),
            isActive: _step >= 3,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Tell your agent how to negotiate on your behalf:'),
              const SizedBox(height: 6),
              TextField(controller: _agentInstr, maxLines: 4,
                  decoration: const InputDecoration(labelText: 'Agent instructions', border: OutlineInputBorder())),
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
                decoration: const InputDecoration(labelText: 'Agent language'),
                items: [for (final l in kAgentLangs) DropdownMenuItem(value: l, child: Text(l))],
                onChanged: (v) => setState(() => _agentLang = v ?? 'English'),
              ),
              TextField(controller: _accent,
                  decoration: const InputDecoration(labelText: 'Accent / persona (optional)', hintText: 'e.g. warm, Punjabi accent')),
              const SizedBox(height: 4),
              const Text('If the other agent doesn’t speak your language, both fall back to English with your accent.',
                  style: TextStyle(fontSize: 11, color: Colors.black54)),
            ]),
          ),
          Step(
            title: const Text('Review'),
            isActive: _step >= 4,
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Listing expires in:'),
              Slider(
                value: _expiryDays.toDouble(), min: 7, max: 90, divisions: 83,
                label: '$_expiryDays days',
                onChanged: (v) => setState(() => _expiryDays = v.round()),
              ),
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
