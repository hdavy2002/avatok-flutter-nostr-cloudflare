import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
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
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../avatok/ava_number.dart';
import '../avatok/contacts.dart';
import 'avatar_crop_screen.dart';
import 'personal_phone_field.dart';

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
  /// The email the user signed in with (from Clerk) — shown locked, and used to
  /// satisfy the required-email validation so "Save & continue" enables.
  final String? email;
  /// Auto-fill values from the Google sign-in (owner request 2026-07-08). Applied
  /// only when the corresponding local field is still empty, so they never clobber
  /// something the user already typed. Birthday/phone would arrive here too once the
  /// extra Google OAuth scopes are enabled in the Clerk dashboard.
  final String? prefillFirstName;
  final String? prefillLastName;
  const ProfileSetupScreen({
    super.key,
    required this.identity,
    required this.onDone,
    required this.onSignOut,
    this.email,
    this.prefillFirstName,
    this.prefillLastName,
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
  final _bio = TextEditingController();

  Identity? _id;
  String _avatarUrl = '';
  // Full date of birth (mandatory, owner request 2026-07-08) + optional time of birth.
  DateTime? _birthDate;
  TimeOfDay? _birthTime;
  // Personal (real) phone — collected + OTP-verified here, then locked. Distinct
  // from the AvaTOK number. Optional (owner decision: sign-in runs on email).
  String _privatePhone = '';
  bool _privatePhoneVerified = false;
  String _gender = ''; // 'male' | 'female' | 'other' — mandatory (Ava's pronouns)
  String _avatokNumber = ''; // chosen in the number gate (shown here, locked)
  bool _photoBusy = false;
  bool _saving = false;

  // R2-F2: profile-completion UX. Per-field GlobalKeys let us scroll the FIRST
  // missing/rejected field into view. `_fieldErrors` drives the red border +
  // helper text under each offending field; `_holdMsg` is the vetting hold copy.
  final _scrollController = ScrollController();
  final _photoKey = GlobalKey();
  final _firstKey = GlobalKey();
  final _lastKey = GlobalKey();
  final _birthYearKey = GlobalKey();
  final _genderKey = GlobalKey();
  final _bioKey = GlobalKey();
  // field id -> inline error text (null/absent = no error).
  final Map<String, String> _fieldErrors = {};
  // While the server round-trips its AI vetting, hold the form (disabled + this
  // message + a spinner). Null when idle.
  String? _holdMsg;

  // ── About-you (bio) live AI moderation ──────────────────────────────────
  // Debounced /api/moderate check on the bio. `_bioOk` gates Save & continue:
  // empty is treated as OK (required-field logic handles emptiness). While a
  // check is in flight `_bioChecking` shows the "Ava is checking…" indicator and
  // Save stays disabled. A blocked verdict turns the field RED + shows a message.
  // Fails OPEN on network error (server re-checks on the write route).
  Timer? _bioTimer;
  bool _bioChecking = false;
  bool _bioOk = true;           // true when the current bio text is clean (or empty)
  String? _bioModError;         // inline reason when the bio is blocked
  String _bioLastChecked = '';
  bool _bioAiBusy = false;      // "write my bio" sparkle in flight

  // ── Gender: AI-detected from the name and LOCKED (owner request 2026-07-08) ──
  // When the server is confident it fills [_gender] + sets [_genderLocked] (the
  // chips become a read-only locked row). An 'unknown'/low-confidence result leaves
  // it unlocked so the user picks manually — so we never trap someone with an
  // unusual name.
  bool _genderLocked = false;
  bool _genderDetecting = false;
  Timer? _genderTimer;
  String _genderNameChecked = '';

  // Server-side rejection reason shown as a prominent red banner above the Save
  // button, so the user always sees WHY Ava rejected the profile even if the
  // offending field can't be highlighted. Cleared on any edit or the next save.
  String? _rejectBanner;

  /// Map a server `field` onto a field this form can actually highlight. The
  /// content moderator reports the combined name as `name`; the form only has
  /// `first_name`/`last_name`, so point `name` at the first-name box (and we red-
  /// border both). Unknown fields fall back to the banner only.
  String _normalizeField(String field) {
    switch (field) {
      case 'name':
      case 'full_name':
      case 'display_name':
        return 'first_name';
      case 'bio':
        return 'about';
      default:
        return field;
    }
  }

  GlobalKey _keyFor(String field) {
    switch (_normalizeField(field)) {
      case 'photo': return _photoKey;
      case 'first_name': return _firstKey;
      case 'last_name': return _lastKey;
      case 'birth_year': return _birthYearKey;
      case 'gender': return _genderKey;
      case 'about':
      case 'bio': return _bioKey;
      default: return _photoKey;
    }
  }

  /// Compute which required fields are still missing, in display order.
  List<String> _missingFields() {
    final m = <String>[];
    if (_avatarUrl.trim().isEmpty) m.add('photo');
    if (_first.text.trim().isEmpty) m.add('first_name');
    if (_last.text.trim().isEmpty) m.add('last_name');
    if (_birthYearValue == null) m.add('birth_year');
    if (_gender.isEmpty) m.add('gender');
    if (_bio.text.trim().isEmpty) m.add('about');
    return m;
  }

  /// Scroll the first offending field into view (post-frame so keys are laid out).
  void _scrollToField(String field) {
    final ctx = _keyFor(field).currentContext;
    if (ctx == null) return;
    Scrollable.ensureVisible(ctx,
        duration: const Duration(milliseconds: 300), curve: Curves.ease, alignment: 0.1);
  }

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
        // Google auto-fill: only when the field is still empty (fresh signup).
        if (_first.text.trim().isEmpty && (widget.prefillFirstName ?? '').isNotEmpty) {
          _first.text = widget.prefillFirstName!.trim();
        }
        if (_last.text.trim().isEmpty && (widget.prefillLastName ?? '').isNotEmpty) {
          _last.text = widget.prefillLastName!.trim();
        }
        // Email is the account you signed in with — prefilled and LOCKED here
        // (owner decision 2026-06-27); change it later in Settings if needed.
        // Prefer the email passed from the auth layer, then telemetry, then any
        // saved profile email.
        _email.text = (widget.email ?? '').isNotEmpty
            ? widget.email!
            : ((Analytics.currentEmail ?? '').isNotEmpty ? Analytics.currentEmail! : p.email);
        // Prefer the full stored DOB; fall back to a year-only legacy profile
        // (construct Jan 1 of that year so the picker has a starting value).
        if (p.birthDate.isNotEmpty) {
          _birthDate = DateTime.tryParse(p.birthDate);
        } else if (p.birthYear != null) {
          _birthDate = DateTime(p.birthYear!, 1, 1);
        }
        if (p.birthTime.isNotEmpty) {
          final parts = p.birthTime.split(':');
          if (parts.length == 2) {
            final h = int.tryParse(parts[0]); final m = int.tryParse(parts[1]);
            if (h != null && m != null) _birthTime = TimeOfDay(hour: h, minute: m);
          }
        }
        _bio.text = p.bio;
        _avatarUrl = p.avatarUrl;
        _privatePhone = p.privatePhone;
        _privatePhoneVerified = p.privatePhoneVerified;
        _gender = p.gender;
      });
      // If a name was auto-filled (Google) or restored and gender isn't set yet,
      // kick off AI gender detection so it can lock without the user retyping.
      if (_first.text.trim().isNotEmpty && _gender.isEmpty) _maybeDetectGender();
    });
    // The AvaTOK number was picked in the gate just before this screen — show it
    // (locked) in place of an editable phone field.
    AvaNumber.me().then((m) {
      if (mounted && (m.display ?? '').isNotEmpty) {
        setState(() { _avatokNumber = m.display!; _phone.text = m.display!; });
      }
    });
  }

  @override
  void dispose() {
    _first.dispose(); _last.dispose(); _email.dispose(); _phone.dispose();
    _bio.dispose();
    _bioTimer?.cancel();
    _genderTimer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  /// The chosen DOB, only if valid: a real date, year ≥ 1900, and at least 13
  /// years ago (the minimum-age rule). Null when unset or invalid.
  DateTime? get _birthDateValue {
    final d = _birthDate;
    if (d == null) return null;
    final cutoff13 = DateTime(DateTime.now().year - 13, DateTime.now().month, DateTime.now().day);
    return (d.year >= 1900 && !d.isAfter(cutoff13)) ? d : null;
  }

  int? get _birthYearValue => _birthDateValue?.year;

  /// Human-readable DOB for the tappable field ('' when unset).
  String get _birthDateLabel {
    final d = _birthDate;
    if (d == null) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return '${d.day} ${months[d.month - 1]} ${d.year}';
  }

  String get _birthTimeLabel {
    final t = _birthTime;
    if (t == null) return '';
    final h = t.hour.toString().padLeft(2, '0');
    final m = t.minute.toString().padLeft(2, '0');
    return '$h:$m';
  }

  Future<void> _pickBirthDate() async {
    final now = DateTime.now();
    final initial = _birthDate ?? DateTime(now.year - 20, 1, 1);
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(1900),
      lastDate: DateTime(now.year - 13, now.month, now.day),
      helpText: 'Select your date of birth',
    );
    if (picked != null) {
      _clearErr('birth_year');
      setState(() => _birthDate = picked);
    }
  }

  Future<void> _pickBirthTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _birthTime ?? const TimeOfDay(hour: 12, minute: 0),
      helpText: 'Time of birth (optional)',
    );
    if (picked != null) setState(() => _birthTime = picked);
  }

  // Phone is intentionally NOT required (owner decision 2026-06-27): users sign
  // in and recover with email + email-OTP. Phone stays optional here, collected
  // later for features like dating verification. Field-level completeness now
  // lives in [_missingFields] (drives the red-border + scroll-to-offender UX).

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
    setState(() { _avatarUrl = url; _photoBusy = false; _fieldErrors.remove('photo'); });
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

  /// Copy shown inline (and used to red-flag) each missing required field.
  String _missingHelper(String field) {
    switch (field) {
      case 'photo': return 'Please add a profile photo.';
      case 'first_name': return 'Please enter your first name.';
      case 'last_name': return 'Please enter your last name.';
      case 'birth_year': return 'Please choose your date of birth (you must be 13+).';
      case 'gender': return 'Please choose how Ava should refer to you.';
      case 'about': return 'Please tell Ava a little about yourself.';
      default: return 'This field is required.';
    }
  }

  // ── Bio live moderation ─────────────────────────────────────────────────
  /// Called on every bio edit. Debounces a /api/moderate check; empty text is
  /// treated as clean. A pending check disables Save (bioOk=false) until the
  /// verdict returns.
  void _onBioChanged() {
    _clearErr('about');
    final text = _bio.text.trim();
    _bioTimer?.cancel();
    if (text.isEmpty) {
      setState(() { _bioChecking = false; _bioModError = null; _bioOk = true; });
      _bioLastChecked = '';
      return;
    }
    if (text == _bioLastChecked && _bioModError == null) {
      setState(() {}); // keep field/photo/name previews fresh
      return;
    }
    setState(() { _bioChecking = true; _bioOk = false; _bioModError = null; });
    _bioTimer = Timer(const Duration(milliseconds: 700), () => _runBioCheck(text));
  }

  Future<void> _runBioCheck(String text) async {
    final res = await ModerationService.check(text, ModField.bio);
    if (!mounted || _bio.text.trim() != text) return; // stale
    _bioLastChecked = text;
    if (res.allow) {
      setState(() { _bioChecking = false; _bioModError = null; _bioOk = true; });
    } else {
      final reason = res.reason.isEmpty ? "This can't go on your AvaTOK profile." : res.reason;
      setState(() { _bioChecking = false; _bioModError = reason; _bioOk = false; });
      Analytics.capture('profile_bio_moderation_blocked', {
        'reason': reason,
        'categories': res.categories.join(','),
        'email': _email.text.trim(),
      });
    }
  }

  // ── AI "write my bio" sparkle ───────────────────────────────────────────
  /// Expand the user's 1–2 lines into a short, safe bio via POST /api/ai/bio.
  /// The generated text is placed in the field and re-run through moderation.
  Future<void> _writeBioWithAi() async {
    if (_bioAiBusy) return;
    final seed = _bio.text.trim();
    if (seed.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Type a line or two about yourself first, then tap the sparkle.')));
      return;
    }
    setState(() => _bioAiBusy = true);
    try {
      final r = await ApiAuth.postJson(
        'https://$kSignalingHost/api/ai/bio', {'seed': seed},
        timeout: const Duration(seconds: 20),
      );
      if (!mounted) return;
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.statusCode == 200 && (body['bio'] ?? '').toString().trim().isNotEmpty) {
        final bio = body['bio'].toString().trim();
        _bio.text = bio;
        _bio.selection = TextSelection.collapsed(offset: bio.length);
        Analytics.capture('profile_bio_ai_generated', {
          'seed_len': seed.length, 'bio_len': bio.length, 'email': _email.text.trim(),
        });
        setState(() => _bioAiBusy = false);
        _onBioChanged(); // re-moderate the generated text
      } else {
        final reason = (body['reason'] ?? '').toString();
        setState(() {
          _bioAiBusy = false;
          if (r.statusCode == 422 && reason.isNotEmpty) { _bioModError = reason; _bioOk = false; }
        });
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(
            reason.isNotEmpty ? reason : "Couldn't write a bio just now — try rephrasing your notes.")));
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _bioAiBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Network issue — try the sparkle again in a moment.')));
    }
  }

  // ── Gender detection from name ──────────────────────────────────────────
  /// Debounced trigger, called on every first/last-name edit. Once we have a
  /// first name we ask the server to infer gender and lock it.
  void _maybeDetectGender() {
    final first = _first.text.trim();
    _genderTimer?.cancel();
    if (first.isEmpty) return;
    if (_genderLocked && first == _genderNameChecked) return; // already resolved for this name
    _genderTimer = Timer(const Duration(milliseconds: 600),
        () => _detectGender('${_first.text.trim()} ${_last.text.trim()}'.trim()));
  }

  Future<void> _detectGender(String fullName) async {
    final first = _first.text.trim();
    if (first.isEmpty) return;
    setState(() => _genderDetecting = true);
    try {
      final r = await ApiAuth.postJson(
        'https://$kSignalingHost/api/ai/gender', {'name': fullName},
        timeout: const Duration(seconds: 12),
      );
      if (!mounted) return;
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      final g = (body['gender'] ?? 'unknown').toString();
      _genderNameChecked = first;
      if (r.statusCode == 200 && (g == 'male' || g == 'female')) {
        setState(() { _gender = g; _genderLocked = true; _genderDetecting = false; });
        _clearErr('gender');
        Analytics.capture('profile_gender_locked', {'gender': g, 'email': _email.text.trim()});
      } else {
        // Unknown / low confidence → let the user choose manually.
        setState(() { _genderLocked = false; _genderDetecting = false; });
      }
    } catch (_) {
      // Fail open: never block the user if the inference call fails.
      if (mounted) setState(() { _genderDetecting = false; _genderLocked = false; });
    }
  }

  String _genderLabel(String g) {
    switch (g) {
      case 'male': return 'Male (he/him)';
      case 'female': return 'Female (she/her)';
      case 'other': return 'Other (they/them)';
      default: return 'Not set';
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    // Block save while the bio is being checked or is flagged unsafe.
    if (_bio.text.trim().isNotEmpty && (!_bioOk || _bioChecking)) {
      setState(() {
        _bioModError ??= _bioChecking
            ? 'Ava is still checking your profile — one moment…'
            : "This can't go on your AvaTOK profile.";
      });
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToField('about'));
      return;
    }
    // Local completeness first: red-border + helper each missing field, then
    // scroll to the FIRST offender. PRESERVES all input.
    final missing = _missingFields();
    if (missing.isNotEmpty) {
      setState(() {
        _fieldErrors.clear();
        for (final f in missing) { _fieldErrors[f] = _missingHelper(f); }
        // Show a banner RIGHT AT the button the user just tapped, so the block is
        // never invisible ("it wouldn't budge"). The scroll-to-offender still runs.
        _rejectBanner = missing.length == 1
            ? _missingHelper(missing.first)
            : 'A few things still needed — starting with: ${_missingHelper(missing.first)}';
      });
      // Telemetry (was previously EMITTED NOTHING — the block was invisible in
      // PostHog). Now measurable so we can see how often users hit it and on which field.
      Analytics.capture('profile_submit_blocked', {
        'first_missing_field': missing.first,
        'missing_count': missing.length,
        'email': _email.text.trim(),
      });
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToField(missing.first));
      return;
    }
    setState(() { _saving = true; _holdMsg = 'Ava is checking your profile…'; _fieldErrors.clear(); _rejectBanner = null; });
    final id = _id ?? await IdentityStore().load();
    if (id == null) {
      if (mounted) {
        setState(() { _saving = false; _holdMsg = null; });
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Still getting your account ready — try once more.')));
      }
      return;
    }
    final first = _first.text.trim();
    final last = _last.text.trim();
    final fullName = '$first $last'.trim();
    final email = _email.text.trim();
    final bio = _bio.text.trim();
    final dob = _birthDateValue;
    final by = dob?.year;
    // Under-18 gate: minors must accept the minor-specific terms before finishing.
    // Day-precise now that we collect a full date (exact on birthdays).
    int? ageYears;
    if (dob != null) {
      final now = DateTime.now();
      ageYears = now.year - dob.year;
      if (now.month < dob.month || (now.month == dob.month && now.day < dob.day)) ageYears = ageYears! - 1;
    }
    final minor = ageYears != null && ageYears < 18;
    final birthDateIso = dob == null
        ? ''
        : '${dob.year.toString().padLeft(4, '0')}-${dob.month.toString().padLeft(2, '0')}-${dob.day.toString().padLeft(2, '0')}';
    if (minor) {
      final accepted = await MinorTerms.ensureAccepted(context, isMinor: true);
      if (!accepted) { if (mounted) setState(() { _saving = false; _holdMsg = null; }); return; }
    }
    final existing = await _store.load();
    // The visible "phone" field shows the AvaTOK number (locked) and is NOT the
    // user's real phone — preserve any previously-stored real phone instead of
    // overwriting it with the AvaTOK number.
    final phone = existing.phone;
    // A PRIOR 422 (e.g. server name/photo vetting reject) latches the profile
    // endpoint's ApiBackoffState into isPermanentlyFailed, after which every
    // registerProfile short-circuits WITHOUT hitting the server and returns a
    // fieldless 422 → the user sees the generic "We couldn't save your profile
    // just now" pinned to the photo and can NEVER save again (even after fixing
    // the offending field) until an app restart. This IS a user-initiated retry,
    // so clear that latch first and let the request reach the server so the real,
    // current vetting result (and its inline message) comes back.
    Directory.resetProfileBackoff();
    final r = await Directory.registerProfile(
        uid: id.uid, name: fullName, firstName: first, lastName: last,
        email: email, phone: phone, avatarUrl: _avatarUrl, birthYear: by, bio: bio, gender: _gender);
    if (!mounted) return;
    // Server vetting failed (moderation / implausible_name / profile_incomplete /
    // photo). Release the hold and tell the user EXACTLY why + WHICH field, so they
    // can fix it and resubmit. PRESERVE all input.
    if (!r.ok) {
      final rawField = (r.field ?? '').isNotEmpty ? r.field! : 'photo';
      final field = _normalizeField(rawField);
      // Prefer the server's detailed, user-facing reason. `message` is the primary
      // channel; `error` is the moderation reason (guardWrite historically sent the
      // reason there). Only fall back to a generic line if the server sent neither.
      var msg = (r.message ?? '').trim().isNotEmpty
          ? r.message!.trim()
          : ((r.error ?? '').trim().isNotEmpty ? r.error!.trim() : '');
      if (msg.isEmpty) {
        msg = r.status == 0
            ? 'Could not save your profile — check your connection and try again.'
            : 'We couldn’t save your profile just now — please try again.';
      }
      // Banner copy names what Ava flagged so it reads like "Ava couldn't save this
      // because …" rather than a bare sentence.
      final banner = 'Ava couldn’t save your profile: $msg';
      setState(() {
        _saving = false;
        _holdMsg = null;
        _rejectBanner = banner;
        _fieldErrors[field] = msg;
        // A combined-name reject should red-border BOTH name boxes.
        if (rawField == 'name' || rawField == 'full_name' || rawField == 'display_name') {
          _fieldErrors['first_name'] = msg;
          _fieldErrors['last_name'] = msg;
        }
      });
      Analytics.capture('profile_save_rejected', {
        'reason': r.error ?? 'unknown', 'field': field, 'raw_field': rawField,
        'status': r.status, 'email': email,
      });
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToField(field));
      return;
    }
    // Only persist locally AFTER the server accepts (so a rejected profile isn't
    // stored as complete — the gate would then wave the user through).
    await _store.save(existing.copyWith(
        displayName: fullName, email: email, phone: phone, avatarUrl: _avatarUrl,
        bio: bio, birthYear: by, birthDate: birthDateIso, birthTime: _birthTimeLabel,
        privatePhone: _privatePhone, privatePhoneVerified: _privatePhoneVerified,
        gender: _gender));
    Analytics.capture('profile_completed', {
      'has_photo': true, 'via': 'mandatory_gate', 'email': email,
    });
    if (!mounted) return;
    setState(() { _saving = false; _holdMsg = null; });
    widget.onDone();
  }

  /// The inline error line for a field (null = none). Clearing an error on the
  /// next edit keeps the form responsive.
  Widget _errFor(String field) {
    final e = _fieldErrors[field];
    if (e == null) return const SizedBox.shrink();
    return ZineErrorMsg(e);
  }

  void _clearErr(String field) {
    if (_fieldErrors.containsKey(field) || _rejectBanner != null) {
      setState(() { _fieldErrors.remove(field); _rejectBanner = null; });
    }
  }

  /// A read-only, tappable field styled like [ZineField] — shows [value] (or the
  /// [hint] placeholder) and opens a picker on tap. Used for the date/time of birth.
  Widget _tappableField({
    required String label,
    required String value,
    required String hint,
    required IconData icon,
    required VoidCallback onTap,
    bool error = false,
  }) {
    final has = value.isNotEmpty;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label.toUpperCase(), style: ZineText.kicker()),
      const SizedBox(height: 9),
      GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          decoration: BoxDecoration(
            color: Zine.card,
            borderRadius: BorderRadius.circular(Zine.rField),
            border: Zine.border,
            boxShadow: error ? Zine.shadowError : Zine.shadowSm,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
          child: Row(children: [
            Icon(icon, size: 20, color: Zine.ink),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                has ? value : hint,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: has
                    ? ZineText.input()
                    : ZineText.input().copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
              ),
            ),
          ]),
        ),
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final id = _id;
    // While the server vets the profile, hold the whole form (disabled + spinner).
    final held = _holdMsg != null;
    // RESPUI: SafeArea + resizeToAvoidBottomInset keep the focused field above
    // the keyboard inset; the body was already a scrollable ListView. Page
    // padding keys off ZineBreakpoints so a <360dp phone gets tighter gutters
    // instead of the same fixed 20px squeezing the layout.
    final hPad = ZineBreakpoints.pagePadding(context);
    return PopScope(
      canPop: false, // mandatory — can't back out until complete
      child: Scaffold(
        backgroundColor: Zine.paper,
        resizeToAvoidBottomInset: true,
        appBar: const ZineAppBar(
            title: 'Complete your profile', markWord: 'profile', showBack: false),
        body: SafeArea(
          child: AbsorbPointer(
          absorbing: held,
          child: ListView(
          controller: _scrollController,
          padding: EdgeInsets.fromLTRB(hPad, 18, hPad, 40 + MediaQuery.of(context).padding.bottom),
          children: [
            if (held)
              Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: Row(children: [
                  const SizedBox(width: 18, height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk)),
                  const SizedBox(width: 10),
                  Expanded(child: Text(_holdMsg!, style: ZineText.value(size: 13))),
                ]),
              ),
            Text('A few details so people can recognise you. Your email and AvaTOK '
                'number are set from sign-up and shown locked below.',
                style: ZineText.sub(size: 13)),
            const SizedBox(height: 18),
            Center(
              key: _photoKey,
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
                      seed: id?.uid ?? 'me',
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
            if (_avatarUrl.isEmpty && !_fieldErrors.containsKey('photo'))
              Center(child: Text('Tap to add a profile photo', style: ZineText.sub(size: 12.5, color: Zine.coral))),
            Center(child: _errFor('photo')),
            const SizedBox(height: 20),
            ZineField(key: _firstKey, controller: _first, label: 'First name', hint: 'Your first name',
                error: _fieldErrors.containsKey('first_name'),
                textCapitalization: TextCapitalization.words,
                onChanged: (_) { _clearErr('first_name'); _maybeDetectGender(); setState(() {}); }),
            _errFor('first_name'),
            const SizedBox(height: 14),
            ZineField(key: _lastKey, controller: _last, label: 'Last name', hint: 'Your last name',
                error: _fieldErrors.containsKey('last_name'),
                textCapitalization: TextCapitalization.words,
                onChanged: (_) { _clearErr('last_name'); _maybeDetectGender(); setState(() {}); }),
            _errFor('last_name'),
            const SizedBox(height: 14),
            ZineField(controller: _email, label: 'Email', hint: 'you@example.com',
                enabled: false),
            const SizedBox(height: 4),
            Text('The email you signed in with — locked here.', style: ZineText.sub(size: 12)),
            const SizedBox(height: 14),
            ZineField(controller: _phone, label: 'Your AvaTOK number',
                hint: _avatokNumber.isEmpty ? 'Assigned just now' : _avatokNumber,
                enabled: false),
            const SizedBox(height: 4),
            Text('This is your AvaTOK number — it represents you and keeps your real '
                'phone private. You can change it later in Settings.', style: ZineText.sub(size: 12)),
            const SizedBox(height: 14),
            // Personal (real) phone with SMS OTP → locked once verified.
            PersonalPhoneField(
              initialPhone: _privatePhone,
              initiallyVerified: _privatePhoneVerified,
              onVerified: (phone) => setState(() {
                _privatePhone = phone;
                _privatePhoneVerified = true;
              }),
            ),
            const SizedBox(height: 14),
            // Date of birth (mandatory) — tappable, opens a date picker.
            Row(key: _birthYearKey, children: [
              Expanded(
                child: _tappableField(
                  label: 'Date of birth (Private)',
                  value: _birthDateLabel,
                  hint: 'Tap to choose',
                  icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
                  error: _fieldErrors.containsKey('birth_year'),
                  onTap: _pickBirthDate,
                ),
              ),
              const SizedBox(width: 10),
              // Time of birth (optional).
              Expanded(
                child: _tappableField(
                  label: 'Time (optional)',
                  value: _birthTimeLabel,
                  hint: '--:--',
                  icon: PhosphorIcons.clock(PhosphorIconsStyle.bold),
                  onTap: _pickBirthTime,
                ),
              ),
            ]),
            _errFor('birth_year'),
            const SizedBox(height: 4),
            Text('Private — never shown to anyone. Used to confirm your age '
                '(under-18 accounts get extra safety protections). Time of birth is optional.',
                style: ZineText.sub(size: 12)),
            const SizedBox(height: 14),
            // ── Gender (mandatory) — AI-detected from the name and LOCKED. Only
            //    editable when detection is uncertain, so an unusual name never traps. ──
            Row(key: _genderKey, children: [
              Text('Gender', style: ZineText.value(size: 13)),
              if (_genderDetecting) ...[
                const SizedBox(width: 8),
                const SizedBox(width: 13, height: 13,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk)),
                const SizedBox(width: 6),
                Text('detecting from your name…', style: ZineText.tag(size: 12, color: Zine.inkSoft)),
              ],
            ]),
            const SizedBox(height: 6),
            if (_genderLocked)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: Zine.card,
                  borderRadius: BorderRadius.circular(Zine.rField),
                  border: Zine.border,
                  boxShadow: Zine.shadowXs,
                ),
                child: Row(children: [
                  PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.fill), size: 18, color: Zine.inkSoft),
                  const SizedBox(width: 10),
                  Expanded(child: Text(_genderLabel(_gender), style: ZineText.value(size: 15))),
                  Text('set from your name', style: ZineText.tag(size: 11, color: Zine.inkSoft)),
                ]),
              )
            else
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final opt in const [
                  ['male', 'Male (he/him)'],
                  ['female', 'Female (she/her)'],
                  ['other', 'Other (they/them)'],
                ])
                  ChoiceChip(
                    label: Text(opt[1]),
                    selected: _gender == opt[0],
                    onSelected: (_) { _clearErr('gender'); setState(() => _gender = opt[0]); },
                  ),
              ]),
            _errFor('gender'),
            const SizedBox(height: 4),
            Text('Ava uses this when she answers your missed calls — '
                '"can I take a message for him/her/them?"', style: ZineText.sub(size: 12)),
            const SizedBox(height: 14),
            // ── About you (bio) — live AI moderation + "write my bio" sparkle ──
            Row(key: _bioKey, children: [
              Expanded(child: Text('ABOUT YOU', style: ZineText.kicker())),
              // Sparkle: type 1–2 lines, tap to have Ava draft a short bio.
              GestureDetector(
                onTap: _bioAiBusy ? null : _writeBioWithAi,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: Zine.lime,
                    borderRadius: BorderRadius.circular(Zine.rField),
                    border: Zine.border,
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (_bioAiBusy)
                      const SizedBox(width: 14, height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink))
                    else
                      PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 15, color: Zine.ink),
                    const SizedBox(width: 6),
                    Text(_bioAiBusy ? 'Writing…' : 'Write my bio',
                        style: ZineText.tag(size: 12, color: Zine.ink)),
                  ]),
                ),
              ),
            ]),
            const SizedBox(height: 9),
            ZineField(controller: _bio, hint: 'Tell Ava a little about yourself…',
                error: _fieldErrors.containsKey('about') || _bioModError != null,
                maxLines: 4, maxLength: 600, textCapitalization: TextCapitalization.sentences,
                onChanged: (_) => _onBioChanged()),
            // "Ava is checking…" indicator while the moderation call is in flight.
            if (_bioChecking)
              Padding(
                padding: const EdgeInsets.only(top: 9),
                child: Row(children: [
                  const SizedBox(width: 14, height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk)),
                  const SizedBox(width: 7),
                  Text('Ava is checking your profile…', style: ZineText.tag(size: 12, color: Zine.inkSoft)),
                ]),
              ),
            // Red inline message when the bio is blocked by moderation.
            if (!_bioChecking && _bioModError != null) ZineErrorMsg(_bioModError!),
            // Required-field (empty) helper still applies.
            if (_bioModError == null) _errFor('about'),
            const SizedBox(height: 24),
            // Prominent rejection banner: names exactly why Ava couldn't save, so
            // the user knows what to change. Disappears as soon as they edit a field.
            if (_rejectBanner != null) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                decoration: BoxDecoration(
                  color: Zine.coral.withValues(alpha: .12),
                  borderRadius: BorderRadius.circular(Zine.rField),
                  border: Border.all(color: Zine.coral, width: Zine.bw),
                ),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  PhosphorIcon(PhosphorIcons.warningCircle(PhosphorIconsStyle.fill),
                      color: Zine.coral, size: 20),
                  const SizedBox(width: 10),
                  Expanded(child: Text(_rejectBanner!,
                      style: ZineText.value(size: 13.5, color: Zine.ink))),
                ]),
              ),
              const SizedBox(height: 14),
            ],
            ZineButton(
              label: _saving ? 'Saving…' : 'Save & continue',
              fullWidth: true, fontSize: 18, loading: _saving,
              // Disabled while the bio is being AI-checked or is flagged unsafe
              // (gate on _bioOk / _bioChecking). Otherwise always tappable so an
              // incomplete submit surfaces the red-border + scroll-to-offender UX
              // instead of a dead button.
              onPressed: (_saving ||
                      (_bio.text.trim().isNotEmpty && (!_bioOk || _bioChecking)))
                  ? null
                  : _save,
            ),
            const SizedBox(height: 14),
            Center(child: GestureDetector(
              onTap: widget.onSignOut,
              child: Text('Sign out instead', style: ZineText.link(size: 13, color: Zine.inkSoft)),
            )),
          ],
        ),
        ),
      ),
    ),
    );
  }
}
