
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/messenger_theme.dart';
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
                  ? uiCopy(UiMessage.m_virtual_number_0a343526ae)
                  : _label.text.trim())
          : await widget.api.createAvaTok(
              requestedNumber: _requested.text,
              label: _label.text.trim().isEmpty
                  ? uiCopy(UiMessage.m_avatok_number_aff0836a28)
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
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return VirtualNumbersUi.shell(
      title: uiCopy(UiMessage.m_add_new_number_2950d5a822),
      onBack: () => Navigator.of(context).pop(),
      child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
          children: [
            UiText(UiMessage.m_choose_a_line_type_1af9e21613, style: AvaDialTheme.title(size: 18)),
            const SizedBox(height: 12),
            _choiceCard(
                0,
                PhosphorIcons.phoneCall(PhosphorIconsStyle.regular),
                'Get a DID virtual number',
                'A provider number for PSTN calls, caller ID, voicemail and SMS where supported.'),
            const SizedBox(height: 10),
            _choiceCard(1, PhosphorIcons.sparkle(PhosphorIconsStyle.regular), 'Create a free Saathum number',
                'In-network AvaTOK calls and messaging. It cannot receive carrier calls, SMS or OTPs.'),
            const SizedBox(height: 18),
            VirtualNumbersUi.sectionLabel('Line label'),
            TextField(
                controller: _label,
                textCapitalization: TextCapitalization.words,
                decoration: InputDecoration(
                    hintText: uiCopy(UiMessage.m_for_work_family_deliveries_eba1ce00ee),
                    prefixIcon: Icon(PhosphorIcons.tag(PhosphorIconsStyle.regular)))),
            const SizedBox(height: 16),
            if (_choice == 0) _didForm() else _avatokForm(),
            const SizedBox(height: 22),
            VirtualNumbersUi.primaryButton(
                label: _choice == 0
                    ? uiCopy(UiMessage.m_purchase_did_600_tokens_30_84e7ff6de3)
                    : uiCopy(UiMessage.m_create_free_avatok_number_976aef8104),
                onPressed: (_choice == 0 && _selectedInventory == null) || _busy
                    ? null
                    : _create,
                icon: _choice == 0 ? PhosphorIcons.shoppingBag(PhosphorIconsStyle.regular) : PhosphorIcons.plus(PhosphorIconsStyle.regular),
                busy: _busy),
          ])); }

  Widget _choiceCard(
      int value, IconData icon, String title, String description) {
    final selected = value == _choice;
    return Semantics(
        inMutuallyExclusiveGroup: true,
        checked: selected,
        label: title,
        child: InkWell(
            onTap: () => setState(() => _choice = value),
            borderRadius: BorderRadius.circular(Msg.rMd),
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
                    borderRadius: BorderRadius.circular(Msg.rMd)),
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
              DropdownMenuItem(value: 'IN', child: UiText(UiMessage.m_india_91_08ca9a2226)),
              DropdownMenuItem(value: 'US', child: UiText(UiMessage.m_united_states_1_ce5c3821df)),
              DropdownMenuItem(value: 'GB', child: UiText(UiMessage.m_united_kingdom_44_0f6c5402c0))
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
              label: const UiText(UiMessage.m_search_available_numbers_148451e7cc)),
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
              decoration:  InputDecoration(labelText: uiCopy(UiMessage.m_available_number_fef43ca719))),
        const SizedBox(height: 8),
        UiText(
            UiMessage.m_rental_is_600_tokens_for_0ec5c55de4,
            style: AvaDialTheme.sub(size: 12)),
      ]);

  Widget _avatokForm() =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        VirtualNumbersUi.sectionLabel('Number preference (optional)'),
        TextField(
            controller: _requested,
            keyboardType: TextInputType.phone,
            decoration: InputDecoration(
                hintText: uiCopy(UiMessage.m_leave_blank_to_generate_one_43c967bf29),
                prefixIcon: Icon(PhosphorIcons.numpad(PhosphorIconsStyle.regular)))),
        const SizedBox(height: 10),
        Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
                color: AvaDialTheme.surface,
                border: Border.all(color: AvaDialTheme.border),
                borderRadius: BorderRadius.circular(Msg.rMd)),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(PhosphorIcons.info(PhosphorIconsStyle.regular), color: AvaDialTheme.unknown),
              const SizedBox(width: 10),
              Expanded(
                  child: UiText(
                      UiMessage.m_free_avatok_numbers_are_in_18a1a134cf,
                      style: AvaDialTheme.sub(size: 12)))
            ])),
      ]);
}
