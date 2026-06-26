import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avatar_cache.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../avatok/contacts.dart';
import 'avatar_crop_screen.dart';

/// MANDATORY profile completion (pic5). Shown by [AvaShell] before the app can
/// be used whenever the saved profile is missing any required field — photo,
/// first name, last name, a valid email, or a valid phone. Applies to BOTH new
/// users (right after onboarding) and existing users (diverted on next open).
/// The screen cannot be dismissed (no back, system back blocked) until every
/// field is filled, validated, and saved; the only escape is signing out.
class ProfileSetupScreen extends StatefulWidget {
  final Identity? identity;
  final VoidCallback onDone;
  final VoidCallback onSignOut;
  const ProfileSetupScreen({
    super.key,
    required this.identity,
    required this.onDone,
    required this.onSignOut,
  });

  @override
  State<ProfileSetupScreen> createState() => _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends State<ProfileSetupScreen> {
  final _store = ProfileStore();
  final _picker = ImagePicker();
  final _first = TextEditingController();
  final _last = TextEditingController();
  final _email = TextEditingController();
  final _phone = TextEditingController();

  Identity? _id;
  String _avatarUrl = '';
  bool _photoBusy = false;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _id = widget.identity;
    if (_id == null) {
      IdentityStore().load().then((id) { if (mounted && id != null) setState(() => _id = id); });
    }
    _store.load().then((p) {
      if (!mounted) return;
      setState(() {
        final parts = p.nameParts;
        _first.text = parts.isNotEmpty ? parts.first : '';
        _last.text = parts.length > 1 ? parts.sublist(1).join(' ') : '';
        _email.text = p.email.isNotEmpty ? p.email : (Analytics.currentEmail ?? '');
        _phone.text = p.phone;
        _avatarUrl = p.avatarUrl;
      });
    });
  }

  @override
  void dispose() {
    _first.dispose(); _last.dispose(); _email.dispose(); _phone.dispose();
    super.dispose();
  }

  bool get _valid =>
      _avatarUrl.trim().isNotEmpty &&
      _first.text.trim().isNotEmpty &&
      _last.text.trim().isNotEmpty &&
      Profile.isValidEmail(_email.text) &&
      Profile.isValidPhone(_phone.text);

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
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't open that image — try another.")));
      }
    }
  }

  Future<void> _uploadAvatar(Uint8List bytes) async {
    setState(() => _photoBusy = true);
    final url = await Directory.uploadAvatar(bytes);
    if (!mounted) return;
    if (url == null) {
      setState(() => _photoBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Upload failed — please try again.')));
      return;
    }
    await AvatarCache.putBytes(url, 192, bytes);
    setState(() { _avatarUrl = url; _photoBusy = false; });
  }

  void _choosePhoto() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: Zine.paper,
          borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r)),
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
        child: SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
          ZineButton(
            label: 'Take photo', fullWidth: true, variant: ZineButtonVariant.blue,
            icon: PhosphorIcons.camera(PhosphorIconsStyle.bold), trailingIcon: false,
            onPressed: () { Navigator.pop(ctx); _pickAndCrop(ImageSource.camera); }),
          const SizedBox(height: 10),
          ZineButton(
            label: 'Choose from gallery', fullWidth: true,
            icon: PhosphorIcons.image(PhosphorIconsStyle.bold), trailingIcon: false,
            onPressed: () { Navigator.pop(ctx); _pickAndCrop(ImageSource.gallery); }),
        ])),
      ),
    );
  }

  Future<void> _save() async {
    if (_saving) return;
    if (!_valid) { setState(() {}); return; }
    setState(() => _saving = true);
    final id = _id ?? await IdentityStore().load();
    if (id == null) {
      if (mounted) {
        setState(() => _saving = false);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Still getting your account ready — try once more.')));
      }
      return;
    }
    final first = _first.text.trim();
    final last = _last.text.trim();
    final fullName = '$first $last'.trim();
    final email = _email.text.trim();
    final phone = _phone.text.trim();
    final existing = await _store.load();
    await _store.save(existing.copyWith(
        displayName: fullName, email: email, phone: phone, avatarUrl: _avatarUrl));
    await Directory.registerProfile(
        npub: id.npub, name: fullName, firstName: first, lastName: last,
        email: email, avatarUrl: _avatarUrl);
    Analytics.capture('profile_completed', {
      'has_photo': true, 'via': 'mandatory_gate', 'email': email, 'phone': phone,
    });
    if (!mounted) return;
    setState(() => _saving = false);
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final id = _id;
    return PopScope(
      canPop: false, // mandatory — can't back out until complete
      child: Scaffold(
        backgroundColor: Zine.paper,
        appBar: const ZineAppBar(
            title: 'Complete your profile', markWord: 'profile', showBack: false),
        body: ListView(
          padding: EdgeInsets.fromLTRB(20, 18, 20, 40 + MediaQuery.of(context).padding.bottom),
          children: [
            Text('A few details so people can recognise and reach you. All fields are required.',
                style: ZineText.sub(size: 13)),
            const SizedBox(height: 18),
            Center(
              child: GestureDetector(
                onTap: _photoBusy ? null : _choosePhoto,
                child: Stack(clipBehavior: Clip.none, children: [
                  Container(
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bw)),
                      boxShadow: Zine.shadowSm,
                    ),
                    child: Avatar(
                      seed: id?.npub ?? 'me',
                      name: _first.text.isEmpty ? 'You' : _first.text,
                      size: 96,
                      avatarUrl: _avatarUrl.isEmpty ? null : _avatarUrl,
                    ),
                  ),
                  if (_photoBusy)
                    Positioned.fill(child: Container(
                      decoration: BoxDecoration(shape: BoxShape.circle, color: Zine.ink.withValues(alpha: .45)),
                      child: const Center(child: SizedBox(width: 22, height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Zine.lime))),
                    )),
                  Positioned(
                    right: -4, bottom: -4,
                    child: Container(
                      width: 34, height: 34,
                      decoration: const BoxDecoration(
                        color: Zine.lime, shape: BoxShape.circle,
                        border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bw)),
                        boxShadow: Zine.shadowXs,
                      ),
                      child: PhosphorIcon(PhosphorIcons.camera(PhosphorIconsStyle.bold), color: Zine.ink, size: 17),
                    ),
                  ),
                ]),
              ),
            ),
            const SizedBox(height: 6),
            if (_avatarUrl.isEmpty)
              Center(child: Text('Tap to add a profile photo', style: ZineText.sub(size: 12.5, color: Zine.coral))),
            const SizedBox(height: 20),
            ZineField(controller: _first, label: 'First name', hint: 'Your first name',
                textCapitalization: TextCapitalization.words, onChanged: (_) => setState(() {})),
            const SizedBox(height: 14),
            ZineField(controller: _last, label: 'Last name', hint: 'Your last name',
                textCapitalization: TextCapitalization.words, onChanged: (_) => setState(() {})),
            const SizedBox(height: 14),
            ZineField(controller: _email, label: 'Email', hint: 'you@example.com',
                keyboardType: TextInputType.emailAddress, onChanged: (_) => setState(() {})),
            const SizedBox(height: 14),
            ZineField(controller: _phone, label: 'Phone', hint: '+1 555 123 4567',
                keyboardType: TextInputType.phone,
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+\s\-()]'))],
                onChanged: (_) => setState(() {})),
            const SizedBox(height: 24),
            ZineButton(
              label: _saving ? 'Saving…' : 'Save & continue',
              fullWidth: true, fontSize: 18, loading: _saving,
              onPressed: (_saving || !_valid) ? null : _save,
            ),
            const SizedBox(height: 14),
            Center(child: GestureDetector(
              onTap: widget.onSignOut,
              child: Text('Sign out instead', style: ZineText.link(size: 13, color: Zine.inkSoft)),
            )),
          ],
        ),
      ),
    );
  }
}
