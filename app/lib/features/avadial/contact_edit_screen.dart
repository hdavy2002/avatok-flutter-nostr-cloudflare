import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'avadial_theme.dart';
import 'contact_overrides.dart';

/// "Add contact" / "Edit contact" screen for a Calls-app (device/PSTN) contact.
///
/// There is no native "write to the OS phone book" channel yet, so this edits an
/// AVA-side [ContactOverride] (account-scoped) layered on top of the read-only
/// device contact — see contact_overrides.dart. When [create] is true the number
/// is editable and the record is saved as a NEW AvaTOK-only contact
/// (`local: true`), which the Contacts tab injects alongside the device book
/// (owner decision 2026-07-13).
///
/// Fields (owner spec, pic 2): display name, number, AvaTOK number, personal
/// email, business email, LinkedIn, plus a "+" that adds arbitrary custom fields
/// (field name + value).
class ContactEditScreen extends StatefulWidget {
  final String number;
  final String? initialName;
  final bool create;
  const ContactEditScreen({
    super.key,
    this.number = '',
    this.initialName,
    this.create = false,
  });

  @override
  State<ContactEditScreen> createState() => _ContactEditScreenState();
}

class _ContactEditScreenState extends State<ContactEditScreen> {
  final _numberCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _avatokCtrl = TextEditingController();
  final _personalEmailCtrl = TextEditingController();
  final _businessEmailCtrl = TextEditingController();
  final _linkedinCtrl = TextEditingController();
  // Custom fields: each a (label, value) controller pair.
  final List<(TextEditingController, TextEditingController)> _custom = [];

  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _numberCtrl.text = widget.number;
    _nameCtrl.text = widget.initialName ?? '';
    _prefill();
  }

  Future<void> _prefill() async {
    if (widget.number.isNotEmpty) {
      final o = await ContactOverrides.I.forNumber(widget.number);
      if (o != null && mounted) {
        _nameCtrl.text = o.displayName ?? widget.initialName ?? '';
        _avatokCtrl.text = o.avatokNumber ?? '';
        _personalEmailCtrl.text = o.personalEmail ?? '';
        _businessEmailCtrl.text = o.businessEmail ?? '';
        _linkedinCtrl.text = o.linkedin ?? '';
        for (final f in o.customFields) {
          _custom.add((
            TextEditingController(text: f.label),
            TextEditingController(text: f.value),
          ));
        }
      }
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  void dispose() {
    for (final c in [
      _numberCtrl,
      _nameCtrl,
      _avatokCtrl,
      _personalEmailCtrl,
      _businessEmailCtrl,
      _linkedinCtrl,
    ]) {
      c.dispose();
    }
    for (final (l, v) in _custom) {
      l.dispose();
      v.dispose();
    }
    super.dispose();
  }

  void _addField() => setState(() =>
      _custom.add((TextEditingController(), TextEditingController())));

  void _removeField(int i) => setState(() {
        final (l, v) = _custom.removeAt(i);
        l.dispose();
        v.dispose();
      });

  String? _trimOrNull(TextEditingController c) {
    final t = c.text.trim();
    return t.isEmpty ? null : t;
  }

  Future<void> _save() async {
    final number = _numberCtrl.text.trim();
    if (number.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Enter a number first')));
      return;
    }
    setState(() => _saving = true);
    final fields = <ContactField>[
      for (final (l, v) in _custom)
        if (l.text.trim().isNotEmpty || v.text.trim().isNotEmpty)
          ContactField(label: l.text.trim(), value: v.text.trim()),
    ];
    await ContactOverrides.I.save(ContactOverride(
      number: number,
      displayName: _trimOrNull(_nameCtrl),
      local: widget.create,
      avatokNumber: _trimOrNull(_avatokCtrl),
      personalEmail: _trimOrNull(_personalEmailCtrl),
      businessEmail: _trimOrNull(_businessEmailCtrl),
      linkedin: _trimOrNull(_linkedinCtrl),
      customFields: fields,
    ));
    Analytics.capture(widget.create ? 'avadial_contact_added' : 'avadial_contact_edited', {
      'has_avatok': _trimOrNull(_avatokCtrl) != null,
      'custom_fields': fields.length,
    });
    if (!mounted) return;
    setState(() => _saving = false);
    Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: Zine.bw)),
        title: Text(widget.create ? 'Add contact' : 'Edit contact',
            style: ZineText.appbar(color: AvaDialTheme.text)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _label('DISPLAY NAME'),
                _field(_nameCtrl, 'Add a name', icon: PhosphorIcons.user(PhosphorIconsStyle.bold)),
                const SizedBox(height: 16),
                _label('NUMBER'),
                widget.create
                    ? _field(_numberCtrl, 'Phone number',
                        icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                        keyboard: TextInputType.phone)
                    : ZineCard(
                        color: AvaDialTheme.surface2,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                        child: Text(widget.number,
                            style: ZineText.value(size: 16, color: AvaDialTheme.text)),
                      ),
                const SizedBox(height: 16),
                _label('AVATOK NUMBER'),
                _field(_avatokCtrl, 'Their AvaTOK number or @handle',
                    icon: PhosphorIcons.chatCircleDots(PhosphorIconsStyle.bold),
                    accent: Zine.lime),
                const SizedBox(height: 16),
                _label('PERSONAL EMAIL'),
                _field(_personalEmailCtrl, 'name@personal.com',
                    icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
                    keyboard: TextInputType.emailAddress),
                const SizedBox(height: 16),
                _label('BUSINESS EMAIL'),
                _field(_businessEmailCtrl, 'name@company.com',
                    icon: PhosphorIcons.briefcase(PhosphorIconsStyle.bold),
                    keyboard: TextInputType.emailAddress),
                const SizedBox(height: 16),
                _label('LINKEDIN'),
                _field(_linkedinCtrl, 'linkedin.com/in/…',
                    icon: PhosphorIcons.linkedinLogo(PhosphorIconsStyle.bold),
                    keyboard: TextInputType.url),
                const SizedBox(height: 16),
                if (_custom.isNotEmpty) _label('MORE FIELDS'),
                for (var i = 0; i < _custom.length; i++) ...[
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(children: [
                      Expanded(
                        flex: 4,
                        child: _plainField(_custom[i].$1, 'Field name'),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 6,
                        child: _plainField(_custom[i].$2, 'Value'),
                      ),
                      IconButton(
                        icon: const Icon(Icons.remove_circle_outline, color: Zine.coral),
                        onPressed: () => _removeField(i),
                      ),
                    ]),
                  ),
                ],
                const SizedBox(height: 4),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: _addField,
                    icon: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold),
                        color: Zine.blue, size: 20),
                    label: Text('Add field',
                        style: ZineText.value(size: 14.5, color: Zine.blue)),
                  ),
                ),
                const SizedBox(height: 14),
                Text(
                  'Saved inside AvaTOK only — your phone\'s own contact book is not '
                  'modified.',
                  style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft),
                ),
                const SizedBox(height: 20),
                ZineButton(
                  label: widget.create ? 'Add contact' : 'Save',
                  variant: ZineButtonVariant.lime,
                  loading: _saving,
                  onPressed: _saving ? null : _save,
                ),
              ],
            ),
    );
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(t, style: ZineText.kicker(color: AvaDialTheme.textMute)),
      );

  Widget _field(TextEditingController c, String hint,
      {IconData? icon, Color? accent, TextInputType? keyboard}) {
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(Zine.rField),
      borderSide: const BorderSide(color: AvaDialTheme.border, width: Zine.bw),
    );
    return TextField(
      controller: c,
      keyboardType: keyboard,
      style: ZineText.value(size: 16, color: AvaDialTheme.text),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: ZineText.sub(size: 15, color: AvaDialTheme.textMute),
        prefixIcon: icon != null
            ? Padding(
                padding: const EdgeInsets.only(left: 12, right: 8),
                child: PhosphorIcon(icon, color: accent ?? AvaDialTheme.textSoft, size: 19),
              )
            : null,
        prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
        filled: true,
        fillColor: AvaDialTheme.surface2,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: border,
        enabledBorder: border,
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(Zine.rField),
          borderSide: BorderSide(color: accent ?? AvaDialTheme.accent, width: Zine.bw),
        ),
      ),
    );
  }

  Widget _plainField(TextEditingController c, String hint) {
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(Zine.rField),
      borderSide: const BorderSide(color: AvaDialTheme.border, width: Zine.bw),
    );
    return TextField(
      controller: c,
      style: ZineText.value(size: 15, color: AvaDialTheme.text),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: ZineText.sub(size: 14, color: AvaDialTheme.textMute),
        filled: true,
        fillColor: AvaDialTheme.surface2,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        border: border,
        enabledBorder: border,
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(Zine.rField),
          borderSide: const BorderSide(color: AvaDialTheme.accent, width: Zine.bw),
        ),
      ),
    );
  }
}
