import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../avadial/avadial_theme.dart';
import 'virtual_numbers_api.dart';
import 'virtual_numbers_widgets.dart';

class VirtualNumberAddScreen extends StatefulWidget {
  const VirtualNumberAddScreen({super.key, required this.api});
  final VirtualNumbersApi api;
  @override
  State<VirtualNumberAddScreen> createState() => _VirtualNumberAddScreenState();
}

class _VirtualNumberAddScreenState extends State<VirtualNumberAddScreen> {
  int _choice = 0;
  final _label = TextEditingController();
  final _requested = TextEditingController();
  String _country = 'IN';
  String? _selectedInventory;
  List<Map<String, dynamic>> _inventory = const [];
  bool _loadingInventory = false;
  bool _busy = false;

  @override
  void dispose() {
    _label.dispose();
    _requested.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() => _loadingInventory = true);
    try {
      final numbers = await widget.api.searchDids(country: _country);
      if (mounted)
        setState(() {
          _inventory = numbers;
          _loadingInventory = false;
          _selectedInventory = numbers.isEmpty
              ? null
              : '${numbers.first['e164'] ?? numbers.first['id'] ?? numbers.first['inventory_id']}';
        });
    } catch (e) {
      if (mounted) {
        setState(() => _loadingInventory = false);
        _message(e.toString());
      }
    }
  }

  Future<void> _create() async {
    setState(() => _busy = true);
    try {
      final line = _choice == 0
          ? await widget.api.purchaseDid(
              inventoryId: _selectedInventory ?? '',
              label: _label.text.trim().isEmpty
                  ? 'Virtual number'
                  : _label.text.trim())
          : await widget.api.createAvaTok(
              requestedNumber: _requested.text,
              label: _label.text.trim().isEmpty
                  ? 'AvaTOK number'
                  : _label.text.trim());
      if (mounted) Navigator.of(context).pop(line);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        _message(e.toString());
      }
    }
  }

  void _message(String value) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(value)));

  @override
  Widget build(BuildContext context) => VirtualNumbersUi.shell(
      title: 'Add new number',
      onBack: () => Navigator.of(context).pop(),
      child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
          children: [
            Text('Choose a line type', style: AvaDialTheme.title(size: 18)),
            const SizedBox(height: 12),
            _choiceCard(
                0,
                PhosphorIcons.phoneCall(PhosphorIconsStyle.regular),
                'Get a DID virtual number',
                'A provider number for PSTN calls, caller ID, voicemail and SMS where supported.'),
            const SizedBox(height: 10),
            _choiceCard(1, PhosphorIcons.sparkle(PhosphorIconsStyle.regular), 'Create a free AvaTOK number',
                'In-network AvaTOK calls and messaging. It cannot receive carrier calls, SMS or OTPs.'),
            const SizedBox(height: 18),
            VirtualNumbersUi.sectionLabel('Line label'),
            TextField(
                controller: _label,
                textCapitalization: TextCapitalization.words,
                decoration: InputDecoration(
                    hintText: 'For work, family, deliveries…',
                    prefixIcon: Icon(PhosphorIcons.tag(PhosphorIconsStyle.regular)))),
            const SizedBox(height: 16),
            if (_choice == 0) _didForm() else _avatokForm(),
            const SizedBox(height: 22),
            VirtualNumbersUi.primaryButton(
                label: _choice == 0
                    ? 'Purchase DID · 600 tokens / 30 days'
                    : 'Create free AvaTOK number',
                onPressed: (_choice == 0 && _selectedInventory == null) || _busy
                    ? null
                    : _create,
                icon: _choice == 0 ? PhosphorIcons.shoppingBag(PhosphorIconsStyle.regular) : PhosphorIcons.plus(PhosphorIconsStyle.regular),
                busy: _busy),
          ]));

  Widget _choiceCard(
      int value, IconData icon, String title, String description) {
    final selected = value == _choice;
    return Semantics(
        inMutuallyExclusiveGroup: true,
        checked: selected,
        label: title,
        child: InkWell(
            onTap: () => setState(() => _choice = value),
            borderRadius: BorderRadius.circular(15),
            child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                    color:
                        selected ? AvaDialTheme.surface2 : AvaDialTheme.surface,
                    border: Border.all(
                        color: selected
                            ? AvaDialTheme.accent
                            : AvaDialTheme.border,
                        width: selected ? 2 : 1),
                    borderRadius: BorderRadius.circular(15)),
                child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(icon,
                          color: selected
                              ? AvaDialTheme.accent
                              : AvaDialTheme.textSoft),
                      const SizedBox(width: 12),
                      Expanded(
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                            Text(title, style: AvaDialTheme.value(size: 15)),
                            const SizedBox(height: 4),
                            Text(description, style: AvaDialTheme.sub(size: 12))
                          ])),
                      Radio<int>(
                          value: value,
                          groupValue: _choice,
                          onChanged: (v) {
                            if (v != null) setState(() => _choice = v);
                          })
                    ]))));
  }

  Widget _didForm() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        VirtualNumbersUi.sectionLabel('Country and inventory'),
        DropdownButtonFormField<String>(
            value: _country,
            items: const [
              DropdownMenuItem(value: 'IN', child: Text('India (+91)')),
              DropdownMenuItem(value: 'US', child: Text('United States (+1)')),
              DropdownMenuItem(value: 'GB', child: Text('United Kingdom (+44)'))
            ],
            onChanged: (value) {
              if (value != null) {
                setState(() => _country = value);
                _search();
              }
            },
            decoration: InputDecoration(prefixIcon: Icon(PhosphorIcons.globe(PhosphorIconsStyle.regular)))),
        const SizedBox(height: 10),
        if (_inventory.isEmpty && !_loadingInventory)
          OutlinedButton.icon(
              onPressed: _search,
              icon: Icon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.regular)),
              label: const Text('Search available numbers')),
        if (_loadingInventory)
          const Padding(
              padding: EdgeInsets.all(12),
              child: Center(child: CircularProgressIndicator())),
        if (_inventory.isNotEmpty)
          DropdownButtonFormField<String>(
              value: _selectedInventory,
              items: _inventory.map((row) {
                final id = '${row['id'] ?? row['inventory_id']}';
                final number =
                    '${row['display_number'] ?? row['number'] ?? id}';
                return DropdownMenuItem(value: id, child: Text(number));
              }).toList(),
              onChanged: (value) => setState(() => _selectedInventory = value),
              decoration: const InputDecoration(labelText: 'Available number')),
        const SizedBox(height: 8),
        Text(
            'Rental is 600 tokens for 30 days. PSTN calls are charged separately at 0.50 tokens/minute.',
            style: AvaDialTheme.sub(size: 12)),
      ]);

  Widget _avatokForm() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        VirtualNumbersUi.sectionLabel('Number preference (optional)'),
        TextField(
            controller: _requested,
            keyboardType: TextInputType.phone,
            decoration: InputDecoration(
                hintText: 'Leave blank to generate one',
                prefixIcon: Icon(PhosphorIcons.numpad(PhosphorIconsStyle.regular)))),
        const SizedBox(height: 10),
        Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: AvaDialTheme.surface,
                border: Border.all(color: AvaDialTheme.border),
                borderRadius: BorderRadius.circular(14)),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(PhosphorIcons.info(PhosphorIconsStyle.regular), color: AvaDialTheme.unknown),
              const SizedBox(width: 10),
              Expanded(
                  child: Text(
                      'Free AvaTOK numbers are in-network aliases. They cannot receive PSTN calls, carrier SMS or bank/delivery OTPs.',
                      style: AvaDialTheme.sub(size: 12)))
            ])),
      ]);
}
