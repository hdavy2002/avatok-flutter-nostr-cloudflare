import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/avatar.dart';
import '../../core/avatar_cache.dart';
import '../../core/config.dart';
import '../../core/minor_terms.dart';
import '../../core/moderation_service.dart';
import '../../core/profile_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../avatok/contacts.dart';
import '../avatok/ava_number.dart';
import 'avatar_crop_screen.dart';
import 'qr_share.dart';

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
  final _name = TextEditingController();  // first name
  final _last = TextEditingController();   // last name
  final _handle = TextEditingController(); // DEPRECATED — handles retired
  final _birthYear = TextEditingController();
  final _bio = TextEditingController();
  final _privatePhone = TextEditingController(); // optional, user-exposed private number
  Identity? _id; // resolved from the passed identity OR the local store
  bool _saving = false;
  bool _listed = false;
  bool _sharePresence = true;
  bool _showPrivateNumber = false; // show private number instead of AvaTOK number
  String _avatarUrl = '';
  String _gender = ''; // 'male' | 'female' | 'other' — mandatory (Ava's pronouns)
  bool _photoBusy = false;
  // AvaTOK Number — the stable QR share link + my current number.
  MyNumber? _myNum;
  String _shareLink = '';

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
        final parts = p.displayName.trim().split(RegExp(r'\s+'));
        _name.text = parts.isNotEmpty ? parts.first : '';
        _last.text = parts.length > 1 ? parts.sublist(1).join(' ') : '';
        _bio.text = p.bio;
        _gender = p.gender;
        _birthYear.text = p.birthYear?.toString() ?? '';
        _listed = !p.isEmpty;
        _sharePresence = p.sharePresence;
        _avatarUrl = p.avatarUrl;
        _privatePhone.text = p.privatePhone;
        _showPrivateNumber = p.showPrivateNumber;
      });
    });
    _initShare();
  }

  /// Build (or refresh) the stable QR share card so others can scan to add me.
  /// Paid users share their AvaTOK number; free users share their real number.
  Future<void> _initShare() async {
    final me = await AvaNumber.me();
    final prof = await _store.load();
    final parts = _name.text.trim().isEmpty ? prof.displayName.split(RegExp(r'\s+')) : _name.text.trim().split(RegExp(r'\s+'));
    final first = parts.isNotEmpty ? parts.first : '';
    final last = parts.length > 1 ? parts.sublist(1).join(' ') : '';
    // Number on the share card. By default this is the virtual AvaTOK number.
    // EXCEPTION (owner request 2026-06-29): if the user has explicitly added a
    // private number AND chosen to expose it, that number REPLACES the AvaTOK
    // number on the card (they've opted in — privacy is their choice).
    final number = (prof.showPrivateNumber && prof.privatePhone.trim().isNotEmpty)
        ? prof.privatePhone.trim()
        : (me.hasNumber ? (me.display ?? '') : '');
    // Personal email — from the stored profile, else from the known account email.
    final email = prof.email.isNotEmpty ? prof.email : (Analytics.currentEmail ?? '');
    if (prof.email.isEmpty && email.isNotEmpty) _store.setEmail(email);
    final res = await AvaNumber.shareCard(firstName: first, lastName: last, email: email, number: number);
    if (!mounted) return;
    setState(() { _myNum = me; _shareLink = res?.link ?? ''; });
  }

  @override
  void dispose() { _name.dispose(); _last.dispose(); _handle.dispose(); _birthYear.dispose(); _bio.dispose(); _privatePhone.dispose(); super.dispose(); }

  /// The number to show on the QR/share card + under the QR. When the user has
  /// opted to expose their private number, that REPLACES the AvaTOK number
  /// everywhere (owner request 2026-06-29); otherwise we use the AvaTOK number.
  String get _cardNumber {
    final priv = _privatePhone.text.trim();
    if (_showPrivateNumber && priv.isNotEmpty) return priv;
    return _myNum?.hasNumber == true ? (_myNum!.display ?? '') : '';
  }

  int? get _birthYearValue {
    final y = int.tryParse(_birthYear.text.trim());
    if (y == null) return null;
    final maxY = DateTime.now().year - 13;
    return (y >= 1900 && y <= maxY) ? y : null;
  }

  /// Every mandatory field present & valid — drives whether Save is enabled.
  /// Owner request 2026-06-27: birth year + "about you" are now compulsory, so
  /// Save stays disabled until they (and the name) are filled in.
  bool get _canSave =>
      _name.text.trim().isNotEmpty &&
      _last.text.trim().isNotEmpty &&
      _bio.text.trim().isNotEmpty &&
      _birthYearValue != null &&
      _gender.isNotEmpty;

  Future<void> _save() async {
    if (_saving) return;
    // CALLFIX-R7: reset backoff on user-initiated save so they can retry after fixing validation errors
    Directory.resetProfileBackoff();
    // Flip to the loading state on the VERY FIRST tap so the button responds
    // immediately (the moderation checks below are async).
    setState(() => _saving = true);
    // Identity is loaded asynchronously in initState (when opened from the
    // sidebar none is passed). The old code silently `return`ed while it was
    // still null, which is why Save needed several taps before it "took". Resolve
    // it here on demand instead.
    var id = _id;
    if (id == null) {
      id = await IdentityStore().load();
      if (id != null && mounted) setState(() => _id = id);
    }
    if (id == null) {
      if (mounted) {
        setState(() => _saving = false);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Still getting your account ready — try once more in a second.')));
      }
      return;
    }
    final first = _name.text.trim();
    final last = _last.text.trim();
    final fullName = [first, last].where((s) => s.isNotEmpty).join(' ').trim();
    // AI content validation — block the save with a clear reason when a name or
    // bio is inappropriate. The Worker re-checks on /api/profile too.
    for (final c in <List<String>>[
      [fullName, ModField.name],
      [_bio.text.trim(), ModField.bio],
    ]) {
      if (c[0].isEmpty) continue;
      final r = await ModerationService.check(c[0], c[1]);
      if (!r.allow) {
        if (!mounted) return;
        setState(() => _saving = false);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(r.reason.isEmpty ? 'Please revise that field.' : r.reason)));
        return;
      }
    }
    // Under-18 gate: if the birth year makes the user a minor, they must accept
    // the minor-specific terms before we save (owner request 2026-06-27).
    final by = _birthYearValue;
    final minor = by != null && (DateTime.now().year - by) < 18;
    if (minor) {
      final accepted = await MinorTerms.ensureAccepted(context, isMinor: true);
      if (!accepted) {
        if (mounted) setState(() => _saving = false);
        return;
      }
    }
    final existing = await _store.load();
    // Personal email — keep it stored so the QR card + email discovery stay complete.
    final email = existing.email.isNotEmpty ? existing.email : (Analytics.currentEmail ?? '');
    // LOCAL-FIRST (owner report 2026-06-27 — "saving takes forever"): persist to the
    // on-device store and release the UI immediately; publish to the directory in
    // the BACKGROUND so a slow/offline network never blocks Save.
    final priv = _privatePhone.text.trim();
    // Can only "show private number" when one is actually entered.
    final showPriv = _showPrivateNumber && priv.isNotEmpty;
    await _store.save(existing.copyWith(
        displayName: fullName, email: email, bio: _bio.text.trim(),
        sharePresence: _sharePresence, birthYear: by, gender: _gender,
        privatePhone: priv, showPrivateNumber: showPriv));
    Analytics.capture('private_number_pref', {
      'has_private_number': priv.isNotEmpty,
      'show_private_number': showPriv,
    });
    // Register the private number server-side so the dialpad can resolve it to
    // this account when exposed (Phase B backend). Fire-and-forget.
    unawaited(AvaNumber.setPrivateNumber(number: priv, show: showPriv));
    // Refresh the share card so the QR immediately reflects the chosen number.
    unawaited(_initShare());
    if (mounted) setState(() { _saving = false; _listed = true; });
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Profile saved')));
    }
    // Background directory publish — fire-and-forget, retried on the next save.
    if (fullName.isNotEmpty || _bio.text.trim().isNotEmpty || email.isNotEmpty) {
      unawaited(Directory.registerProfile(uid: id.uid, name: fullName, firstName: first, lastName: last,
          email: email, avatarUrl: _avatarUrl, birthYear: _birthYearValue, bio: _bio.text.trim(), gender: _gender));
    }
  }

  // ---- profile photo ----
  Future<void> _editPhoto() async {
    final hasPhoto = _avatarUrl.isNotEmpty;
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
        child: SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 38, height: 5,
            margin: const EdgeInsets.only(bottom: 14),
            decoration: BoxDecoration(color: AD.borderControl, borderRadius: BorderRadius.circular(3)),
          ),
          _sheetTile(ctx, PhosphorIcons.camera(PhosphorIconsStyle.bold), AD.iconSearch, 'Take photo',
              () { Navigator.pop(ctx); _pickAndCrop(ImageSource.camera); }),
          const SizedBox(height: 10),
          _sheetTile(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), AD.primaryBadge, 'Choose from gallery',
              () { Navigator.pop(ctx); _pickAndCrop(ImageSource.gallery); }),
          if (hasPhoto) ...[
            const SizedBox(height: 10),
            _sheetTile(ctx, PhosphorIcons.trash(PhosphorIconsStyle.bold), AD.danger, 'Remove photo',
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
      color: AD.card,
      borderColor: AD.borderControl,
      radius: BorderRadius.circular(AD.rListCard),
      boxShadow: const [],
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(children: [
        ZineIconBadge(icon: icon, color: accent, size: 32),
        const SizedBox(width: 12),
        Expanded(child: Text(label,
            style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary).copyWith(fontSize: 15))),
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
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

  String get _fullName => [_name.text.trim(), _last.text.trim()].where((s) => s.isNotEmpty).join(' ').trim();

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
    await Directory.registerProfile(uid: id.uid, name: _fullName, firstName: _name.text.trim(), lastName: _last.text.trim(), avatarUrl: url);
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
    await Directory.registerProfile(uid: id.uid, name: _fullName, firstName: _name.text.trim(), lastName: _last.text.trim(), avatarUrl: '');
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
          backgroundColor: AD.popover,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AD.rDialog),
            side: const BorderSide(color: AD.borderControl, width: 1),
          ),
          title: Text('Change email', style: ADText.threadName().copyWith(fontSize: 19)),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            AdField(
              controller: emailCtrl,
              enabled: !sent,
              label: 'New email address',
              keyboardType: TextInputType.emailAddress,
            ),
            if (sent) ...[
              const SizedBox(height: 14),
              AdField(
                controller: codeCtrl,
                label: '6-digit code from your inbox',
                keyboardType: TextInputType.number,
              ),
            ],
            if (err != null) AdErrorMsg(err!),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(),
                child: Text('Not now', style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14))),
            AdButton(label: sent ? 'Verify' : 'Send code', variant: AdButtonVariant.teal,
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
          backgroundColor: AD.popover,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AD.rDialog),
            side: const BorderSide(color: AD.borderControl, width: 1),
          ),
          title: Text(sent ? 'Set password' : 'Set or change password', style: ADText.threadName().copyWith(fontSize: 19)),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            if (!sent)
              Text('We\'ll email a 6-digit code to confirm it\'s you.', style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13)),
            if (sent) ...[
              Text('Code sent${hint != null && hint!.isNotEmpty ? ' to $hint' : ''}.',
                  style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13)),
              const SizedBox(height: 12),
              AdField(controller: codeCtrl, label: '6-digit code', keyboardType: TextInputType.number),
              const SizedBox(height: 12),
              AdField(controller: pwCtrl, label: 'New password', obscureText: true),
            ],
            if (err != null) AdErrorMsg(err!),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(),
                child: Text('Not now', style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14))),
            AdButton(label: sent ? 'Set password' : 'Send code', variant: AdButtonVariant.teal,
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
          color: AD.card,
          borderColor: AD.borderControl,
          radius: BorderRadius.circular(AD.rListCard),
          boxShadow: const [],
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.rowName().copyWith(fontSize: 15)),
              const SizedBox(height: 2),
              Text(subtitle, style: ADText.preview().copyWith(fontSize: 12)),
            ])),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
          ]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final id = _id;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(84),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 18, 12),
              child: Row(children: [
                const AdBackButton(),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Profile', style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis),
                      const SizedBox(height: 2),
                      Text('YOUR PUBLIC CARD', style: ADText.sectionLabel()),
                    ],
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
      // Generous bottom padding (plus the system nav-bar inset) so the Update
      // button always sits comfortably above the nav bar — never chopped.
      body: ListView(padding: EdgeInsets.fromLTRB(20, 20, 20, 40 + MediaQuery.of(context).padding.bottom), children: [
        Center(
          child: GestureDetector(
            onTap: _photoBusy ? null : _editPhoto,
            child: Stack(clipBehavior: Clip.none, children: [
              // White-ringed avatar (dark v2 §4).
              Container(
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.fromBorderSide(BorderSide(color: AD.borderAvatar, width: 2)),
                  boxShadow: [],
                ),
                child: Avatar(
                  seed: id?.uid ?? 'me',
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
                        color: Colors.black.withValues(alpha: .45)),
                    child: const Center(child: SizedBox(width: 22, height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AD.primaryBadge))),
                  ),
                ),
              // Orange camera seal.
              Positioned(
                right: -4, bottom: -4,
                child: Container(
                  width: 34, height: 34,
                  decoration: const BoxDecoration(
                    color: AD.primaryBadge,
                    shape: BoxShape.circle,
                    border: Border.fromBorderSide(BorderSide(color: AD.bg, width: 2)),
                    boxShadow: [],
                  ),
                  child: PhosphorIcon(PhosphorIcons.camera(PhosphorIconsStyle.bold), color: Colors.white, size: 17),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(height: 16),
        Center(child: Text(_fullName.isEmpty ? 'You' : _fullName,
            style: ADText.appTitle())),
        const SizedBox(height: 22),
        AdField(
          controller: _name,
          label: 'First name',
          hint: 'Your first name',
          textCapitalization: TextCapitalization.words,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 16),
        AdField(
          controller: _last,
          label: 'Last name',
          hint: 'Your last name',
          textCapitalization: TextCapitalization.words,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 7),
        Text('People find you by your AvaTOK number, phone, or email — set your number in Settings → Your number.',
            style: ADText.preview()),
        const SizedBox(height: 16),
        AdField(
          controller: _birthYear,
          label: 'Birth year (Private)',
          hint: 'e.g. 1990',
          keyboardType: TextInputType.number,
          maxLength: 4,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 7),
        Text('Private — never shown to anyone. Required. Used to confirm your age '
            '(under-18 accounts get extra safety protections) and for anonymous '
            'age-group stats (e.g. "25-34").',
            style: ADText.preview()),
        const SizedBox(height: 16),
        Text('Gender', style: ADText.rowName().copyWith(fontSize: 13.5)),
        const SizedBox(height: 7),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final opt in const [
            ['male', 'Male (he/him)'],
            ['female', 'Female (she/her)'],
            ['other', 'Other (they/them)'],
          ])
            ChoiceChip(
              label: Text(opt[1]),
              selected: _gender == opt[0],
              onSelected: (_) => setState(() => _gender = opt[0]),
              backgroundColor: AD.card,
              selectedColor: AD.primaryBadge,
              side: BorderSide(color: _gender == opt[0] ? AD.primaryBadge : AD.borderControl, width: 1),
              labelStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800,
                  fontSize: 13, color: _gender == opt[0] ? Colors.white : AD.textSecondary),
            ),
        ]),
        const SizedBox(height: 7),
        Text('Ava uses this when she answers your missed calls — '
            '"can I take a message for him/her/them?"', style: ADText.preview()),
        const SizedBox(height: 16),
        AdField(
          controller: _bio,
          label: 'About you',
          hint: 'Tell Ava a little about yourself…',
          maxLines: 4,
          maxLength: 600,
          textCapitalization: TextCapitalization.sentences,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 7),
        Text('Private to you. Ava reads this to personalise its help — manage what Ava '
            'learns from in Settings → AvaBrain.', style: ADText.preview()),
        const SizedBox(height: 16),
        AdCard(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Share last seen / online', style: ADText.rowName().copyWith(fontSize: 14.5)),
              const SizedBox(height: 2),
              Text('Let contacts see when you are online', style: ADText.preview().copyWith(fontSize: 12)),
            ])),
            const SizedBox(width: 10),
            ZineToggle(value: _sharePresence, onChanged: (v) => setState(() => _sharePresence = v)),
          ]),
        ),
        const SizedBox(height: 16),
        // Optional private phone number the user may CHOOSE to expose (owner
        // request 2026-06-29). Off by default; not verified yet (VERIFICATION STUB
        // — Profile.privatePhoneVerified). When the switch is on, this number
        // replaces the AvaTOK number on the QR card and contact areas.
        Text('PRIVATE PHONE NUMBER (OPTIONAL)', style: ADText.sectionLabel()),
        const SizedBox(height: 10),
        AdField(
          controller: _privatePhone,
          label: 'Private phone number',
          hint: 'e.g. +1 302 555 0148',
          keyboardType: TextInputType.phone,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 7),
        Text('Optional and private by default. Not verified yet — verification is '
            'coming later. Only shown to others if you turn on the switch below.',
            style: ADText.preview()),
        const SizedBox(height: 12),
        AdCard(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Show my private number instead of my AvaTOK number', style: ADText.rowName().copyWith(fontSize: 14.5)),
              const SizedBox(height: 2),
              Text('People see this number on your card and can call it on AvaTOK. '
                  'Your AvaTOK number is hidden while this is on.', style: ADText.preview().copyWith(fontSize: 12)),
            ])),
            const SizedBox(width: 10),
            ZineToggle(
              value: _showPrivateNumber && _privatePhone.text.trim().isNotEmpty,
              onChanged: _privatePhone.text.trim().isEmpty
                  ? null
                  : (v) => setState(() => _showPrivateNumber = v),
            ),
          ]),
        ),
        const SizedBox(height: 16),
        Text('ACCOUNT & SECURITY', style: ADText.sectionLabel()),
        const SizedBox(height: 10),
        _securityRow(PhosphorIcons.envelope(PhosphorIconsStyle.bold), AD.iconSearch,
            'Change email', 'Verify the new address with a 6-digit code', _changeEmail),
        _securityRow(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), AD.iconVideo,
            'Password', 'Set or change your sign-in password', _changePassword),
        const SizedBox(height: 6),
        if (id != null) AdCard(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.qrCode(PhosphorIconsStyle.bold), color: AD.iconSearch, size: 28),
              const SizedBox(width: 9),
              Expanded(child: Text('ADD ME ON AVATOK', style: ADText.sectionLabel())),
            ]),
            const SizedBox(height: 12),
            if (_shareLink.isNotEmpty)
              Center(child: Container(
                padding: const EdgeInsets.all(8),
                // QR stays dark-on-white so it remains scannable.
                decoration: BoxDecoration(color: AD.inputField, borderRadius: BorderRadius.circular(14), border: Border.all(color: AD.borderControl, width: 1)),
                child: QrImageView(data: _shareLink, size: 150, backgroundColor: AD.inputField),
              ))
            else
              const Center(child: Padding(padding: EdgeInsets.all(28), child: CircularProgressIndicator(color: AD.primaryBadge))),
            const SizedBox(height: 10),
            Center(child: Text(
              _cardNumber.isNotEmpty ? _cardNumber : 'Scan to add me on AvaTOK',
              style: ADText.rowName(c: AD.iconSearch).copyWith(fontSize: 15))),
            if (_cardNumber.isEmpty && _myNum != null && !_myNum!.hasNumber)
              Padding(padding: const EdgeInsets.only(top: 4), child: Center(child:
                Text('Generate your AvaTOK number in Settings → Your number to share it, '
                    'or add a private number above and choose to show it.',
                    textAlign: TextAlign.center, style: ADText.preview().copyWith(fontSize: 11.5)))),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: AdButton(
                label: 'Share', icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), trailingIcon: false,
                fullWidth: true, fontSize: 15,
                onPressed: _shareLink.isEmpty ? null : () async {
                  try {
                    await QrShare.share(link: _shareLink, name: _fullName, number: _cardNumber);
                  } catch (_) {
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text("Couldn't prepare the QR image — try again.")));
                  }
                })),
              const SizedBox(width: 10),
              Expanded(child: AdButton(
                label: 'Copy', variant: AdButtonVariant.ghost, icon: PhosphorIcons.copy(PhosphorIconsStyle.bold), trailingIcon: false,
                fullWidth: true, fontSize: 15,
                onPressed: _shareLink.isEmpty ? null : () {
                  Analytics.capture('qr_card_action', {'action': 'copy'});
                  Clipboard.setData(ClipboardData(text: _shareLink));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Link copied')));
                })),
            ]),
            const SizedBox(height: 10),
            // Owner request 2026-06-29: Download a JPEG of the card, or Print it to
            // post at a business — both use the identical QrShare layout.
            Row(children: [
              Expanded(child: AdButton(
                label: 'Download', variant: AdButtonVariant.ghost, icon: PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold), trailingIcon: false,
                fullWidth: true, fontSize: 15,
                onPressed: _shareLink.isEmpty ? null : () async {
                  try {
                    final path = await QrShare.download(link: _shareLink, name: _fullName, number: _cardNumber);
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text('Saved QR card to $path')));
                  } catch (_) {
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text("Couldn't save the image.")));
                  }
                })),
              const SizedBox(width: 10),
              Expanded(child: AdButton(
                label: 'Print', variant: AdButtonVariant.ghost, icon: PhosphorIcons.printer(PhosphorIconsStyle.bold), trailingIcon: false,
                fullWidth: true, fontSize: 15,
                onPressed: _shareLink.isEmpty ? null : () async {
                  try {
                    await QrShare.printCard(link: _shareLink, name: _fullName, number: _cardNumber);
                  } catch (_) {
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text("Couldn't open the print dialog.")));
                  }
                })),
            ]),
          ]),
        ),
        const SizedBox(height: 22),
        AdButton(
          label: _listed ? 'Update profile' : 'Save & get discoverable',
          fullWidth: true,
          fontSize: 19,
          loading: _saving,
          // Save is enabled only when every mandatory field is filled — removing
          // birth year or "about you" disables it (owner request 2026-06-27).
          onPressed: (_saving || !_canSave) ? null : _save,
        ),
        if (!_canSave) ...[
          const SizedBox(height: 8),
          Center(child: Text('First name, last name, birth year and "about you" are all required.',
              style: ADText.preview(c: AD.danger).copyWith(fontSize: 12))),
        ],
      ]),
    );
  }
}
