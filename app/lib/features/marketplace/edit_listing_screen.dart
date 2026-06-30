import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/cached_image.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import 'sell_listing_flow.dart'
    show kMarketCategories, kMarketCurrencies, kCountries, kCountryCodes, flagFor;

/// AvaMarketplace — full Zine-themed editor for an existing listing (pic 5).
/// Replaces the cramped bottom-sheet editor: edit title, description, price +
/// currency, category, country, location, photos and expiry, then save. Loads
/// the full listing (the list card has no description) before editing.
class EditListingScreen extends StatefulWidget {
  final String listingId;
  const EditListingScreen({super.key, required this.listingId});
  @override
  State<EditListingScreen> createState() => _EditListingScreenState();
}

class _EditListingScreenState extends State<EditListingScreen> {
  bool _loading = true;
  bool _busy = false;
  String? _error;

  final _title = TextEditingController();
  final _desc = TextEditingController();
  final _price = TextEditingController();
  final _location = TextEditingController();
  String _currency = 'USD';
  String _category = kMarketCategories.first;
  String _country = 'US';
  int? _expiryDays; // null = keep current expiry
  final List<String> _coverUrls = [];
  bool _uploading = false;

  @override
  void initState() {
    super.initState();
    Analytics.capture('listing_edit_opened', {'listing_id': widget.listingId});
    _load();
  }

  Future<void> _load() async {
    final d = await ListingsApi.detail(widget.listingId);
    if (!mounted) return;
    if (d == null) { setState(() { _loading = false; _error = 'Could not load this listing.'; }); return; }
    final l = d.listing;
    _title.text = l.title;
    _desc.text = l.description ?? '';
    _price.text = l.price > 0 ? l.price.toString() : '';
    _currency = kMarketCurrencies.contains(l.currency) ? l.currency : 'USD';
    _category = kMarketCategories.contains(l.category) ? l.category : kMarketCategories.first;
    final cc = (l.country ?? '').toUpperCase();
    final dev = WidgetsBinding.instance.platformDispatcher.locale.countryCode?.toUpperCase();
    _country = kCountries.containsKey(cc) ? cc : (dev != null && kCountries.containsKey(dev) ? dev : 'US');
    _location.text = l.location ?? '';
    for (final m in l.coverMedia) {
      final url = (m is Map ? m['url'] : null)?.toString();
      if (url != null && url.startsWith('http')) _coverUrls.add(url);
    }
    setState(() => _loading = false);
  }

  InputDecoration _box({String? hint}) => InputDecoration(
        hintText: hint,
        filled: true,
        fillColor: Colors.white,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Colors.black, width: 2)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Colors.black, width: 2)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Colors.black, width: 2)),
      );

  Widget _field(String label, Widget input) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 6, top: 2),
            child: Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Colors.black)),
          ),
          input,
        ],
      );

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

  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    final fields = <String, dynamic>{
      'title': _title.text.trim(),
      'description': _desc.text.trim(),
      'category': _category,
      'country': _country,
      'location': _location.text.trim(),
      'price_amount': int.tryParse(_price.text.trim()) ?? 0,
      'price_currency': _currency,
      'cover_media': [for (final u in _coverUrls) {'type': 'image', 'url': u}],
      if (_expiryDays != null) 'expiry_days': _expiryDays,
    };
    final ok = await ListingsApi.update(widget.listingId, fields);
    if (!mounted) return;
    Analytics.capture('listing_edited', {'listing_id': widget.listingId, 'expiry_changed': _expiryDays != null});
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Listing updated.')));
      Navigator.of(context).pop(true);
    } else {
      setState(() { _busy = false; _error = 'Could not save your changes. Try again.'; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F1E8),
      appBar: AppBar(title: const Text('Edit listing'), backgroundColor: const Color(0xFFF5F1E8), elevation: 0),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
              _field('Title', TextField(controller: _title, decoration: _box(hint: 'What are you listing?'))),
              const SizedBox(height: 14),
              _field('Description', TextField(controller: _desc, maxLines: 4, decoration: _box(hint: 'Add the details buyers need'))),
              const SizedBox(height: 14),
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(child: _field('Price', TextField(
                  controller: _price, keyboardType: TextInputType.number, decoration: _box(hint: '0')))),
                const SizedBox(width: 12),
                SizedBox(width: 120, child: _field('Currency', DropdownButtonFormField<String>(
                  value: _currency, isExpanded: true, decoration: _box(),
                  items: [for (final c in kMarketCurrencies) DropdownMenuItem(value: c, child: Text(c))],
                  onChanged: (v) => setState(() => _currency = v ?? 'USD'),
                ))),
              ]),
              const SizedBox(height: 14),
              _field('Category', DropdownButtonFormField<String>(
                value: _category, isExpanded: true, decoration: _box(),
                items: [for (final c in kMarketCategories) DropdownMenuItem(value: c, child: Text(c))],
                onChanged: (v) => setState(() => _category = v ?? kMarketCategories.first),
              )),
              const SizedBox(height: 14),
              _field('Country', DropdownButtonFormField<String>(
                value: _country, isExpanded: true, decoration: _box(),
                items: [for (final cc in kCountryCodes) DropdownMenuItem(value: cc, child: Text('${flagFor(cc)}  ${kCountries[cc]}'))],
                onChanged: (v) => setState(() => _country = v ?? _country),
              )),
              const SizedBox(height: 14),
              _field('Location', TextField(controller: _location, decoration: _box(hint: 'City or area'))),
              const SizedBox(height: 16),
              const Text('Photos — max 5', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Colors.black)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (var i = 0; i < _coverUrls.length; i++)
                  Stack(children: [
                    CachedImage(_coverUrls[i], width: 84, height: 84, radius: BorderRadius.circular(8)),
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
                      decoration: BoxDecoration(border: Border.all(color: Colors.black26), borderRadius: BorderRadius.circular(8)),
                      child: Center(child: _uploading
                          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.add_a_photo_outlined)),
                    ),
                  ),
              ]),
              const SizedBox(height: 18),
              const Text('Renew expiry (optional)', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Colors.black)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final dch in const [1, 5, 10, 20, 30])
                  ChoiceChip(
                    label: Text('$dch day${dch == 1 ? '' : 's'}'),
                    selected: _expiryDays == dch,
                    onSelected: (_) => setState(() => _expiryDays = _expiryDays == dch ? null : dch),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(100), side: const BorderSide(color: Colors.black, width: 2)),
                    backgroundColor: Colors.white,
                    selectedColor: const Color(0xFFC4F24D),
                  ),
              ]),
              if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: Colors.red, fontWeight: FontWeight.w600))),
            ]),
      // Save pinned in a safe-area bar so it's never cut off behind the nav bar (pic 8).
      bottomNavigationBar: _loading ? null : Container(
        decoration: const BoxDecoration(
          color: Color(0xFFF5F1E8),
          border: Border(top: BorderSide(color: Colors.black, width: 2)),
        ),
        child: SafeArea(
          minimum: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          child: SizedBox(
            height: 52, width: double.infinity,
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFC4F24D), foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(100), side: const BorderSide(color: Colors.black, width: 2)),
              ),
              onPressed: _busy ? null : _save,
              child: Text(_busy ? 'Saving…' : 'Save changes', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            ),
          ),
        ),
      ),
    );
  }
}
