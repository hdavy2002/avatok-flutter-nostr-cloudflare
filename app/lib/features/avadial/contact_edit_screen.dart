import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'avadial_theme.dart';
import 'contact_overrides.dart';

/// "Edit contact" screen for a Calls-app (device/PSTN) contact. There is no
/// native "write to the OS phone book" channel yet, so this edits an AVA-side
/// [ContactOverride] (a display-name override, account-scoped) layered on top of
/// the read-only device contact — see contact_overrides.dart for why.
class ContactEditScreen extends StatefulWidget {
  final String number;
  final String? initialName;
  const ContactEditScreen({super.key, required this.number, this.initialName});

  @override
  State<ContactEditScreen> createState() => _ContactEditScreenState();
}

class _ContactEditScreenState extends State<ContactEditScreen> {
  late final TextEditingController _nameCtrl = TextEditingController(text: widget.initialName ?? '');
  bool _saving = false;

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final name = _nameCtrl.text.trim();
    await ContactOverrides.I.setName(widget.number, name.isEmpty ? null : name);
    Analytics.capture('avadial_contact_edited', const {});
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
        title: Text('Edit contact', style: ZineText.appbar(color: AvaDialTheme.text)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('NUMBER', style: ZineText.kicker(color: AvaDialTheme.textMute)),
          const SizedBox(height: 6),
          ZineCard(
            color: AvaDialTheme.surface2,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Text(widget.number, style: ZineText.value(size: 16, color: AvaDialTheme.text)),
          ),
          const SizedBox(height: 18),
          Text('DISPLAY NAME', style: ZineText.kicker(color: AvaDialTheme.textMute)),
          const SizedBox(height: 6),
          TextField(
            controller: _nameCtrl,
            style: ZineText.value(size: 16, color: AvaDialTheme.text),
            decoration: InputDecoration(
              hintText: 'Add a name for this number',
              hintStyle: ZineText.sub(size: 15, color: AvaDialTheme.textMute),
              filled: true,
              fillColor: AvaDialTheme.surface2,
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Zine.rField),
                borderSide: const BorderSide(color: AvaDialTheme.border, width: Zine.bw),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Zine.rField),
                borderSide: const BorderSide(color: AvaDialTheme.border, width: Zine.bw),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Zine.rField),
                borderSide: const BorderSide(color: AvaDialTheme.accent, width: Zine.bw),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'This only changes how the name appears inside AvaTOK — your phone\'s '
            'own contact book is not modified.',
            style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft),
          ),
          const SizedBox(height: 22),
          ZineButton(
            label: 'Save',
            variant: ZineButtonVariant.lime,
            loading: _saving,
            onPressed: _saving ? null : _save,
          ),
        ],
      ),
    );
  }
}
