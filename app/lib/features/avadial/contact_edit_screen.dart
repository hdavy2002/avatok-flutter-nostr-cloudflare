import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'avadial_theme.dart';
import 'contact_overrides.dart';
import 'device_contacts.dart';

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
  final _addressCtrl = TextEditingController();
  final _linkedinCtrl = TextEditingController();
  // Custom fields: each a (label, value) controller pair.
  final List<(TextEditingController, TextEditingController)> _custom = [];

  bool _loading = true;
  bool _saving = false;

  // [AVADIAL-HARDEN-3] INITIAL values of the managed fields as loaded, so _save
  // can tell "was cleared" (initial non-empty, now empty) from "was always empty"
  // — only the former is an intentional clear (see _computeClearFields). _initNote
  // is the initial COMPUTED note blob (see _buildNote) since there's no raw
  // free-text "note" control on this screen — it's synthesized from the AvaTOK
  // number + custom fields for the device's Note row.
  String _initName = '';
  String _initNumber = '';
  String _initPersonalEmail = '';
  String _initBusinessEmail = '';
  String _initLinkedin = '';
  String _initAddress = '';
  String _initNote = '';

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
        _addressCtrl.text = o.address ?? '';
        _linkedinCtrl.text = o.linkedin ?? '';
        for (final f in o.customFields) {
          _custom.add((
            TextEditingController(text: f.label),
            TextEditingController(text: f.value),
          ));
        }
      }
    }
    // Snapshot the INITIAL values (post-prefill) for the clear-field diff on save.
    _initName = _nameCtrl.text.trim();
    _initNumber = _numberCtrl.text.trim();
    _initPersonalEmail = _personalEmailCtrl.text.trim();
    _initBusinessEmail = _businessEmailCtrl.text.trim();
    _initLinkedin = _linkedinCtrl.text.trim();
    _initAddress = _addressCtrl.text.trim();
    _initNote = _buildNote(
          _trimOrNull(_avatokCtrl),
          [
            for (final (l, v) in _custom)
              if (l.text.trim().isNotEmpty || v.text.trim().isNotEmpty)
                ContactField(label: l.text.trim(), value: v.text.trim()),
          ],
        ) ??
        '';
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
      _addressCtrl,
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

  /// Extras that have no first-class OS-contact slot (AvaTOK number + custom
  /// fields) are stored in the contact's Note so the phone's address book keeps
  /// them too. Returns null when there's nothing extra to store.
  String? _buildNote(String? avatok, List<ContactField> fields) {
    final lines = <String>[
      if (avatok != null && avatok.isNotEmpty) 'AvaTOK: $avatok',
      for (final f in fields)
        if (f.value.isNotEmpty) '${f.label.isEmpty ? 'Note' : f.label}: ${f.value}',
    ];
    return lines.isEmpty ? null : lines.join('\n');
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
    final name = _trimOrNull(_nameCtrl);
    final personalEmail = _trimOrNull(_personalEmailCtrl);
    final businessEmail = _trimOrNull(_businessEmailCtrl);
    final address = _trimOrNull(_addressCtrl);
    final linkedin = _trimOrNull(_linkedinCtrl);
    final avatok = _trimOrNull(_avatokCtrl);
    // Fold the AvaTOK-specific extras into the OS contact's Note so they survive in
    // the phone's own address book too (the rich fields still live in the override).
    final note = _buildNote(avatok, fields);

    // [AVADIAL-HARDEN-3] A managed field that HAD a value when the form loaded and
    // is blank now is an intentional clear — everything else (always-empty, or
    // simply untouched) stays a no-op, same as before. See _initName etc.
    final clearFields = <String>[
      if (_initName.isNotEmpty && (name ?? '').isEmpty) 'name',
      if (_initNumber.isNotEmpty && number.isEmpty) 'number',
      if (_initPersonalEmail.isNotEmpty && (personalEmail ?? '').isEmpty) 'personalEmail',
      if (_initBusinessEmail.isNotEmpty && (businessEmail ?? '').isEmpty) 'businessEmail',
      if (_initLinkedin.isNotEmpty && (linkedin ?? '').isEmpty) 'linkedin',
      if (_initAddress.isNotEmpty && (address ?? '').isEmpty) 'address',
      if (_initNote.isNotEmpty && (note ?? '').isEmpty) 'note',
    ];

    // Write to the REAL phone address book (owner request 2026-07-13). We resolve
    // the device contact id for an edit; on create we insert. If the device write
    // fails (permission denied / unsupported), we keep the AVA-side override so the
    // edit is never lost — hence `local` is only set when the device write didn't land.
    await DeviceContacts.I.load(); // ensure the lookup index is warm
    final deviceId = DeviceContacts.I.lookup(number)?.id;
    var onDevice = false;
    if (widget.create) {
      final id = await DeviceContacts.I.write(
        name: name ?? number,
        number: number,
        personalEmail: personalEmail,
        businessEmail: businessEmail,
        linkedin: linkedin,
        note: note,
        address: address,
      );
      onDevice = id != null;
    } else if (deviceId != null) {
      onDevice = await DeviceContacts.I.update(
        id: deviceId,
        name: name ?? number,
        number: number,
        personalEmail: personalEmail,
        businessEmail: businessEmail,
        linkedin: linkedin,
        note: note,
        address: address,
        clearFields: clearFields,
      );
    }

    await ContactOverrides.I.save(ContactOverride(
      number: number,
      displayName: name,
      local: widget.create && !onDevice,
      avatokNumber: avatok,
      personalEmail: personalEmail,
      businessEmail: businessEmail,
      linkedin: linkedin,
      address: address,
      customFields: fields,
    ));
    Analytics.capture(widget.create ? 'avadial_contact_added' : 'avadial_contact_edited', {
      'has_avatok': avatok != null,
      'custom_fields': fields.length,
      'on_device': onDevice,
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
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        // Explicit close (X) so it's obvious how to back out without saving
        // (owner request — the default back arrow was too faint to notice).
        leading: IconButton(
          icon: const Icon(Icons.close, color: AvaDialTheme.text),
          tooltip: 'Cancel',
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
        ),
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
                    : AdCard(
                        color: AvaDialTheme.surface2,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                        child: Text(widget.number,
                            style: ZineText.value(size: 16, color: AvaDialTheme.text)),
                      ),
                const SizedBox(height: 16),
                _label('AVATOK NUMBER'),
                _field(_avatokCtrl, 'Their AvaTOK number or @handle',
                    icon: PhosphorIcons.chatCircleDots(PhosphorIconsStyle.bold),
                    accent: AD.primaryBadge),
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
                _label('ADDRESS'),
                _field(_addressCtrl, 'Street, city, postal code…',
                    icon: PhosphorIcons.mapPin(PhosphorIconsStyle.bold),
                    keyboard: TextInputType.streetAddress,
                    maxLines: 3),
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
                        icon: const Icon(Icons.remove_circle_outline, color: AD.danger),
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
                        color: AD.iconSearch, size: 20),
                    label: Text('Add field',
                        style: ZineText.value(size: 14.5, color: AD.iconSearch)),
                  ),
                ),
                const SizedBox(height: 14),
                Text(
                  'Saved to your phone\'s contacts. Extra AvaTOK details (AvaTOK '
                  'number, custom fields) are kept in AvaTOK.',
                  style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft),
                ),
                // Bottom breathing room so the last field can scroll clear of the
                // pinned action bar below (which is OUTSIDE this list).
                const SizedBox(height: 12),
              ],
            ),
      // [AVADIAL-CONTACT-CTA-1] (owner report 2026-07-16, pic 1): the primary
      // CTA used to be the last child of the ListView, so on a tall form with
      // the keyboard up it sat under the system gesture bar and read as
      // "hidden below". Pin it to the bottom instead, inside a SafeArea, so
      // "Add contact" is always reachable without scrolling and never collides
      // with the nav bar or the keyboard.
      bottomNavigationBar: _loading
          ? null
          : Container(
              decoration: const BoxDecoration(
                color: AvaDialTheme.surface,
                border: Border(top: BorderSide(color: AvaDialTheme.border, width: 1)),
              ),
              child: SafeArea(
                top: false,
                minimum: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                child: AdButton(
                  label: widget.create ? 'Add contact' : 'Save',
                  variant: AdButtonVariant.primary,
                  loading: _saving,
                  onPressed: _saving ? null : _save,
                ),
              ),
            ),
    );
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(t, style: ZineText.kicker(color: AvaDialTheme.textMute)),
      );

  Widget _field(TextEditingController c, String hint,
      {IconData? icon, Color? accent, TextInputType? keyboard, int maxLines = 1}) {
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(AD.rInput),
      borderSide: const BorderSide(color: AvaDialTheme.border, width: 1),
    );
    return TextField(
      controller: c,
      keyboardType: keyboard,
      maxLines: maxLines,
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
          borderRadius: BorderRadius.circular(AD.rInput),
          borderSide: BorderSide(color: accent ?? AvaDialTheme.accent, width: 1),
        ),
      ),
    );
  }

  Widget _plainField(TextEditingController c, String hint) {
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(AD.rInput),
      borderSide: const BorderSide(color: AvaDialTheme.border, width: 1),
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
          borderRadius: BorderRadius.circular(AD.rInput),
          borderSide: const BorderSide(color: AvaDialTheme.accent, width: 1),
        ),
      ),
    );
  }
}
