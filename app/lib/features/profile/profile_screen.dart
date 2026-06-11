import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/avatar_cache.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../avatok/contacts.dart';
import 'avatar_crop_screen.dart';
import 'phone_verify_card.dart';

/// Set your public display name + @handle. Saving publishes you to the AvaTok
/// directory (opt-in discovery) and makes your @handle resolvable.
class ProfileScreen extends StatefulWidget {
  final Identity? identity;
  const ProfileScreen({super.key, this.identity});
  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _store = ProfileStore();
  final _picker = ImagePicker();
  final _name = TextEditingController();
  final _handle = TextEditingController();
  final _birthYear = TextEditingController();
  bool _saving = false;
  bool _listed = false;
  bool _sharePresence = true;
  String _avatarUrl = '';
  bool _photoBusy = false;

  @override
  void initState() {
    super.initState();
    _store.load().then((p) {
      if (!mounted) return;
      setState(() {
        _name.text = p.displayName;
        _handle.text = p.handle;
        _listed = !p.isEmpty;
        _sharePresence = p.sharePresence;
        _avatarUrl = p.avatarUrl;
      });
    });
  }

  @override
  void dispose() { _name.dispose(); _handle.dispose(); _birthYear.dispose(); super.dispose(); }

  int? get _birthYearValue {
    final y = int.tryParse(_birthYear.text.trim());
    if (y == null) return null;
    final maxY = DateTime.now().year - 13;
    return (y >= 1900 && y <= maxY) ? y : null;
  }

  Future<void> _save() async {
    final id = widget.identity;
    if (id == null || _saving) return;
    final handle = _handle.text.trim().toLowerCase().replaceAll('@', '');
    setState(() => _saving = true);
    final existing = await _store.load();
    await _store.save(existing.copyWith(displayName: _name.text.trim(), handle: handle, sharePresence: _sharePresence));
    // Opt-in discovery: publish to the directory so others can find me.
    if (_name.text.trim().isNotEmpty || handle.isNotEmpty) {
      await Directory.registerProfile(npub: id.npub, handle: handle, name: _name.text.trim(), avatarUrl: _avatarUrl,
          birthYear: _birthYearValue);
    }
    if (!mounted) return;
    setState(() { _saving = false; _listed = true; });
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Profile saved — people can now find you')));
  }

  // ---- profile photo ----
  Future<void> _editPhoto() async {
    final hasPhoto = _avatarUrl.isNotEmpty;
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: Zine.paper,
          borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r)),
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
        child: SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 38, height: 5,
            margin: const EdgeInsets.only(bottom: 14),
            decoration: BoxDecoration(color: Zine.inkMute, borderRadius: BorderRadius.circular(3)),
          ),
          _sheetTile(ctx, PhosphorIcons.camera(PhosphorIconsStyle.bold), Zine.blue, 'Take photo',
              () { Navigator.pop(ctx); _pickAndCrop(ImageSource.camera); }),
          const SizedBox(height: 10),
          _sheetTile(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), Zine.lime, 'Choose from gallery',
              () { Navigator.pop(ctx); _pickAndCrop(ImageSource.gallery); }),
          if (hasPhoto) ...[
            const SizedBox(height: 10),
            _sheetTile(ctx, PhosphorIcons.trash(PhosphorIconsStyle.bold), Zine.coral, 'Remove photo',
                () { Navigator.pop(ctx); _removePhoto(); }, danger: true),
          ],
        ])),
      ),
    );
  }

  Widget _sheetTile(BuildContext ctx, IconData icon, Color accent, String label, VoidCallback onTap,
      {bool danger = false}) {
    return ZinePressable(
      onTap: onTap,
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: Zine.shadowXs,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(children: [
        ZineIconBadge(icon: icon, color: accent, size: 32),
        const SizedBox(width: 12),
        Expanded(child: Text(label,
            style: ZineText.value(size: 15, color: danger ? Zine.coral : Zine.ink))),
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
      ]),
    );
  }

  Future<void> _pickAndCrop(ImageSource source) async {
    try {
      final x = await _picker.pickImage(source: source, maxWidth: 1600, imageQuality: 92);
      if (x == null) return;
      final bytes = await x.readAsBytes();
      if (!mounted) return;
      final cropped = await Navigator.push<Uint8List?>(
          context, MaterialPageRoute(builder: (_) => AvatarCropScreen(imageBytes: bytes)));
      if (cropped == null || !mounted) return;
      await _uploadAvatar(cropped);
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Couldn't open that image — try another.")));
    }
  }

  String get _cleanHandle => _handle.text.trim().toLowerCase().replaceAll('@', '');

  Future<void> _uploadAvatar(Uint8List bytes) async {
    final id = widget.identity;
    if (id == null) return;
    setState(() => _photoBusy = true);
    final url = await Directory.uploadAvatar(bytes);
    if (url == null) {
      if (mounted) {
        setState(() => _photoBusy = false);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Upload failed — please try again.')));
      }
      return;
    }
    await AvatarCache.putBytes(url, 192, bytes); // instant display (avatar requests ~192px)
    final p = await _store.load();
    await _store.save(p.copyWith(avatarUrl: url));
    await Directory.registerProfile(npub: id.npub, handle: _cleanHandle, name: _name.text.trim(), avatarUrl: url);
    if (!mounted) return;
    setState(() { _avatarUrl = url; _photoBusy = false; });
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Photo updated')));
  }

  Future<void> _removePhoto() async {
    final id = widget.identity;
    if (id == null) return;
    setState(() => _photoBusy = true);
    final p = await _store.load();
    await _store.save(p.copyWith(avatarUrl: ''));
    await Directory.registerProfile(npub: id.npub, handle: _cleanHandle, name: _name.text.trim(), avatarUrl: '');
    if (!mounted) return;
    setState(() { _avatarUrl = ''; _photoBusy = false; });
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Photo removed')));
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.identity;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Profile', markWord: 'Profile', tag: 'your public card'),
      // Generous bottom padding (plus the system nav-bar inset) so the Update
      // button always sits comfortably above the nav bar — never chopped.
      body: ListView(padding: EdgeInsets.fromLTRB(20, 20, 20, 40 + MediaQuery.of(context).padding.bottom), children: [
        Center(
          child: GestureDetector(
            onTap: _photoBusy ? null : _editPhoto,
            child: Stack(clipBehavior: Clip.none, children: [
              // Ink-ringed avatar with a hard offset shadow (§4).
              Container(
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bw)),
                  boxShadow: Zine.shadowSm,
                ),
                child: Avatar(
                  seed: id?.npub ?? 'me',
                  name: _name.text.isEmpty ? 'You' : _name.text,
                  size: 96,
                  avatarUrl: _avatarUrl.isEmpty ? null : _avatarUrl,
                ),
              ),
              if (_photoBusy)
                Positioned.fill(
                  child: Container(
                    decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Zine.ink.withValues(alpha: .45)),
                    child: const Center(child: SizedBox(width: 22, height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Zine.lime))),
                  ),
                ),
              // Lime camera seal.
              Positioned(
                right: -4, bottom: -4,
                child: Container(
                  width: 34, height: 34,
                  decoration: const BoxDecoration(
                    color: Zine.lime,
                    shape: BoxShape.circle,
                    border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bw)),
                    boxShadow: Zine.shadowXs,
                  ),
                  child: PhosphorIcon(PhosphorIcons.camera(PhosphorIconsStyle.bold), color: Zine.ink, size: 17),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(height: 16),
        Center(child: Text(_name.text.isEmpty ? 'You' : _name.text,
            style: ZineText.cardTitle(size: 22))),
        if (_cleanHandle.isNotEmpty) ...[
          const SizedBox(height: 3),
          Center(child: Text('@$_cleanHandle', style: ZineText.link(size: 13))),
        ],
        const SizedBox(height: 22),
        ZineField(
          controller: _name,
          label: 'Display name',
          hint: 'Your name',
          textCapitalization: TextCapitalization.words,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _handle,
          label: 'Handle',
          leadText: '@',
          hint: 'yourhandle',
          onChanged: (_) => setState(() {}),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[a-zA-Z0-9_]'))],
        ),
        const SizedBox(height: 7),
        Text('Others can add you by @handle. Leave blank to stay unlisted.',
            style: ZineText.sub(size: 12.5)),
        const SizedBox(height: 16),
        ZineField(
          controller: _birthYear,
          label: 'Birth year (optional)',
          hint: 'e.g. 1990',
          keyboardType: TextInputType.number,
          maxLength: 4,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        ),
        const SizedBox(height: 7),
        Text('Never shown to anyone. Helps creators see anonymous age-group stats (e.g. "25-34").',
            style: ZineText.sub(size: 12.5)),
        const SizedBox(height: 16),
        ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          boxShadow: Zine.shadowXs,
          child: Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Share last seen / online', style: ZineText.value(size: 14.5)),
              const SizedBox(height: 2),
              Text('Let contacts see when you are online', style: ZineText.sub(size: 12)),
            ])),
            const SizedBox(width: 10),
            ZineToggle(value: _sharePresence, onChanged: (v) => setState(() => _sharePresence = v)),
          ]),
        ),
        const SizedBox(height: 16),
        const PhoneVerifyCard(),
        const SizedBox(height: 12),
        if (id != null) ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(14),
          boxShadow: Zine.shadowXs,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.fingerprint(PhosphorIconsStyle.bold), color: Zine.blue, size: 28),
              const SizedBox(width: 9),
              Expanded(child: Text('YOUR AVATOK ID (NPUB)', style: ZineText.kicker())),
            ]),
            const SizedBox(height: 9),
            Row(children: [
              Expanded(child: SelectableText(id.npub, style: ZineText.tag(size: 11, color: Zine.inkSoft))),
              ZineBackButton(
                icon: PhosphorIcons.copy(PhosphorIconsStyle.bold),
                onTap: () {
                  Clipboard.setData(ClipboardData(text: id.npub));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                },
              ),
            ]),
          ]),
        ),
        const SizedBox(height: 22),
        ZineButton(
          label: _listed ? 'Update profile' : 'Save & get discoverable',
          fullWidth: true,
          fontSize: 19,
          loading: _saving,
          onPressed: _saving ? null : _save,
        ),
      ]),
    );
  }
}
