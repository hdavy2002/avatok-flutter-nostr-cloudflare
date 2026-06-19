import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/avatar.dart';
import '../../core/avatar_cache.dart';
import '../../core/config.dart';
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
  final _bio = TextEditingController();
  Identity? _id; // resolved from the passed identity OR the local store
  bool _saving = false;
  bool _listed = false;
  bool _sharePresence = true;
  String _avatarUrl = '';
  bool _photoBusy = false;

  @override
  void initState() {
    super.initState();
    _id = widget.identity;
    // When opened from the sidebar / identity hub no identity is passed, so load
    // it ourselves — otherwise Save and photo upload would silently no-op.
    if (_id == null) {
      IdentityStore().load().then((id) { if (mounted && id != null) setState(() => _id = id); });
    }
    _store.load().then((p) {
      if (!mounted) return;
      setState(() {
        _name.text = p.displayName;
        _handle.text = p.handle;
        _bio.text = p.bio;
        _listed = !p.isEmpty;
        _sharePresence = p.sharePresence;
        _avatarUrl = p.avatarUrl;
      });
    });
  }

  @override
  void dispose() { _name.dispose(); _handle.dispose(); _birthYear.dispose(); _bio.dispose(); super.dispose(); }

  int? get _birthYearValue {
    final y = int.tryParse(_birthYear.text.trim());
    if (y == null) return null;
    final maxY = DateTime.now().year - 13;
    return (y >= 1900 && y <= maxY) ? y : null;
  }

  Future<void> _save() async {
    final id = _id;
    if (id == null || _saving) return;
    final handle = _handle.text.trim().toLowerCase().replaceAll('@', '');
    setState(() => _saving = true);
    final existing = await _store.load();
    await _store.save(existing.copyWith(
        displayName: _name.text.trim(), handle: handle, bio: _bio.text.trim(),
        sharePresence: _sharePresence));
    // Opt-in discovery: publish to the directory so others can find me. Bio rides
    // along so AvaBrain can learn from it (server-side, consent-gated).
    if (_name.text.trim().isNotEmpty || handle.isNotEmpty || _bio.text.trim().isNotEmpty) {
      await Directory.registerProfile(npub: id.npub, handle: handle, name: _name.text.trim(), avatarUrl: _avatarUrl,
          birthYear: _birthYearValue, bio: _bio.text.trim());
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
    final id = _id;
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
    final id = _id;
    if (id == null) return;
    setState(() => _photoBusy = true);
    final p = await _store.load();
    await _store.save(p.copyWith(avatarUrl: ''));
    await Directory.registerProfile(npub: id.npub, handle: _cleanHandle, name: _name.text.trim(), avatarUrl: '');
    if (!mounted) return;
    setState(() { _avatarUrl = ''; _photoBusy = false; });
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Photo removed')));
  }

  /// Change the sign-in email — sends a 6-digit OTP to the NEW address and only
  /// switches once it's verified (same flow as the identity hub).
  Future<void> _changeEmail() async {
    final emailCtrl = TextEditingController();
    final codeCtrl = TextEditingController();
    var sent = false;
    String? err;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setS) {
        Future<void> send() async {
          final r = await ApiAuth.postJson(kEmailOtpStartUrl, {'email': emailCtrl.text.trim()});
          setS(() {
            sent = r.statusCode == 200;
            err = sent ? null : 'Could not send the code — check the address.';
          });
        }

        Future<void> verify() async {
          final r = await ApiAuth.postJson(
              kEmailOtpVerifyUrl, {'email': emailCtrl.text.trim(), 'code': codeCtrl.text.trim()});
          if (r.statusCode == 200) {
            if (ctx.mounted) Navigator.of(ctx).pop();
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Email updated')));
            }
          } else {
            setS(() => err = 'Incorrect or expired code.');
          }
        }

        return AlertDialog(
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text('Change email', style: ZineText.cardTitle()),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineField(
              controller: emailCtrl,
              enabled: !sent,
              label: 'New email address',
              keyboardType: TextInputType.emailAddress,
            ),
            if (sent) ...[
              const SizedBox(height: 14),
              ZineField(
                controller: codeCtrl,
                label: '6-digit code from your inbox',
                keyboardType: TextInputType.number,
              ),
            ],
            if (err != null) ZineErrorMsg(err!),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(),
                child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft))),
            ZineButton(label: sent ? 'Verify' : 'Send code', variant: ZineButtonVariant.blue,
                fontSize: 15, onPressed: sent ? verify : send),
          ],
        );
      }),
    );
  }

  /// Set or change the account password (email+password sign-in, alongside
  /// Google). Step 1 emails a 6-digit code to the account email; step 2 verifies
  /// the code and sets the new password on the server (Clerk Backend API).
  Future<void> _changePassword() async {
    final codeCtrl = TextEditingController();
    final pwCtrl = TextEditingController();
    var sent = false;
    var busy = false;
    String? err;
    String? hint;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setS) {
        Future<void> send() async {
          setS(() { busy = true; err = null; });
          final r = await ApiAuth.postJson(kPasswordResetStartUrl, const {});
          String? h;
          try { h = (r.statusCode == 200) ? (jsonDecode(r.body)['email_hint'] ?? '').toString() : null; } catch (_) {}
          setS(() {
            busy = false;
            sent = r.statusCode == 200;
            hint = h;
            err = sent ? null : 'Could not send the code — please try again.';
          });
        }

        Future<void> set() async {
          if (pwCtrl.text.length < 8) { setS(() => err = 'Password must be at least 8 characters.'); return; }
          setS(() { busy = true; err = null; });
          final r = await ApiAuth.postJson(
              kPasswordSetUrl, {'code': codeCtrl.text.trim(), 'password': pwCtrl.text});
          if (r.statusCode == 200) {
            if (ctx.mounted) Navigator.of(ctx).pop();
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Password updated')));
            }
          } else {
            String msg = 'Incorrect or expired code.';
            try { msg = (jsonDecode(r.body)['error'] ?? msg).toString(); } catch (_) {}
            setS(() { busy = false; err = msg; });
          }
        }

        return AlertDialog(
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text(sent ? 'Set password' : 'Set or change password', style: ZineText.cardTitle()),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            if (!sent)
              Text('We\'ll email a 6-digit code to confirm it\'s you.', style: ZineText.sub(size: 13)),
            if (sent) ...[
              Text('Code sent${hint != null && hint!.isNotEmpty ? ' to $hint' : ''}.',
                  style: ZineText.sub(size: 13)),
              const SizedBox(height: 12),
              ZineField(controller: codeCtrl, label: '6-digit code', keyboardType: TextInputType.number),
              const SizedBox(height: 12),
              ZineField(controller: pwCtrl, label: 'New password', obscureText: true),
            ],
            if (err != null) ZineErrorMsg(err!),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(),
                child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft))),
            ZineButton(label: sent ? 'Set password' : 'Send code', variant: ZineButtonVariant.blue,
                fontSize: 15, loading: busy, onPressed: busy ? null : (sent ? set : send)),
          ],
        );
      }),
    );
  }

  Widget _securityRow(IconData icon, Color accent, String title, String subtitle, VoidCallback onTap) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZinePressable(
          onTap: onTap,
          radius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowXs,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ZineText.value(size: 15)),
              const SizedBox(height: 2),
              Text(subtitle, style: ZineText.sub(size: 12)),
            ])),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final id = _id;
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
        ZineField(
          controller: _bio,
          label: 'About you',
          hint: 'Tell Ava a little about yourself…',
          maxLines: 4,
          maxLength: 600,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 7),
        Text('Private to you. Ava reads this to personalise its help — manage what Ava '
            'learns from in Settings → AvaBrain.', style: ZineText.sub(size: 12.5)),
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
        // Soft nudge for users who skipped phone at onboarding (non-dismissible
        // here — the profile editor is the natural place to add it). Shows a
        // verified row once done.
        const PhoneNudgeCard(source: 'profile', collapsible: false),
        const SizedBox(height: 6),
        Text('ACCOUNT & SECURITY', style: ZineText.kicker()),
        const SizedBox(height: 10),
        _securityRow(PhosphorIcons.envelope(PhosphorIconsStyle.bold), Zine.blue,
            'Change email', 'Verify the new address with a 6-digit code', _changeEmail),
        _securityRow(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), Zine.lilac,
            'Password', 'Set or change your sign-in password', _changePassword),
        const SizedBox(height: 6),
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
