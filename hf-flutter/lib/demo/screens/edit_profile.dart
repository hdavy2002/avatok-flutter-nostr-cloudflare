import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/models/me.dart';
import '../../data/repos/settings_repo.dart';
import '../../data/services.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-APP-PARITY-PROFILE] Edit profile: first name, last name, the name influencers see (the saved one, else the first name, like the website)
/// and the permanent @handle (read-only). Saves with `PUT /api/hf/me/profile`, then updates "Name influencers see" with `PATCH /api/hf/me`.
class EditProfileScreen extends StatefulWidget {
  const EditProfileScreen({super.key, this.repo, this.me, this.onSaved});

  final SettingsRepo? repo;

  /// Shown at once while the profile loads; defaults to `Services.instance.me`.
  final Me? me;

  /// Called after a successful save so the app reloads `/api/hf/me`. Defaults to `Services.instance.refreshMe`.
  final Future<void> Function()? onSaved;

  @override
  State<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends State<EditProfileScreen> {
  final _first = TextEditingController();
  final _last = TextEditingController();
  ProfileData? _data;
  Object? _loadError;
  String? _saveError;
  bool _saving = false;

  SettingsRepo get _repo => widget.repo ?? SettingsRepo(Services.instance.api);

  @override
  void initState() {
    super.initState();
    _first.addListener(_typed);
    _last.addListener(_typed);
    unawaited(_load());
  }

  @override
  void dispose() {
    _first.dispose();
    _last.dispose();
    super.dispose();
  }

  void _typed() {
    if (mounted) setState(() => _saveError = null);
  }

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final d = await _repo.profile();
      if (!mounted) return;
      final me = widget.me ?? Services.instance.me;
      // The profile call is the source of truth; /me only fills a name part the profile call left empty.
      final data = ProfileData(
        firstName: d.firstName.isNotEmpty ? d.firstName : (me?.firstName ?? ''),
        lastName: d.lastName.isNotEmpty ? d.lastName : (me?.lastName ?? ''),
        handle: d.handle ?? me?.handle,
        displayName: d.displayName,
      );
      _first.text = data.firstName;
      _last.text = data.lastName;
      setState(() => _data = data);
    } catch (e) {
      if (mounted) setState(() => _loadError = e);
    }
  }

  static final _bad = RegExp(r'[0-9<>@/\\]');

  /// Same rule as the server: 1 to 30 characters, no digits, links or handles.
  String? _check(String label, String v) {
    final s = v.trim();
    if (s.isEmpty) return 'Please enter your $label.';
    if (s.runes.length > 30 || _bad.hasMatch(s)) return 'Names can have 1 to 30 letters, no numbers or links.';
    return null;
  }

  String get _preview => influencerFacingName(_data?.displayName, _first.text);

  bool get _changed {
    final d = _data;
    if (d == null) return false;
    return _first.text.trim() != d.firstName || _last.text.trim() != d.lastName;
  }

  String? get _problem => _check('first name', _first.text) ?? _check('last name', _last.text);

  Future<void> _save() async {
    final problem = _problem;
    if (problem != null) {
      setState(() => _saveError = problem);
      return;
    }
    setState(() {
      _saving = true;
      _saveError = null;
    });
    var d = _data!;
    try {
      final namesChanged = _changed;
      if (namesChanged) {
        final saved = await _repo.saveProfileNames(firstName: _first.text, lastName: _last.text);
        d = ProfileData(firstName: saved.firstName, lastName: saved.lastName, handle: saved.handle ?? d.handle, displayName: saved.displayName ?? d.displayName);
        _data = d;
      }
      // Like the website: a person who never had a "name influencers see" gets her first name there.
      final want = influencerFacingName(d.displayName, d.firstName);
      if (want.isNotEmpty && want != (d.displayName ?? '')) {
        final stored = await _repo.saveName(want);
        d = ProfileData(firstName: d.firstName, lastName: d.lastName, handle: d.handle, displayName: stored);
        _data = d;
      }
      await (widget.onSaved ?? Services.instance.refreshMe)();
      if (!mounted) return;
      toast(context, 'Profile saved.');
      if (context.canPop()) context.pop();
    } catch (e) {
      if (!mounted) return;
      setState(() => _saveError = e is ApiException ? e.userMessage : 'We could not save your profile. Please try again.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(children: [
          const BookHeader('Edit profile'),
          Expanded(child: _body()),
        ]),
      ),
    );
  }

  Widget _body() {
    if (_data == null) {
      if (_loadError != null) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(
                _loadError is ApiException ? (_loadError as ApiException).userMessage : 'We could not load your profile.',
                key: const Key('profile-load-error'),
                textAlign: TextAlign.center,
                style: t(16, color: C.muted, w: FontWeight.w700),
              ),
              const SizedBox(height: 14),
              ChunkyButton(label: 'Try again', onTap: _load),
            ]),
          ),
        );
      }
      return const Center(child: CircularProgressIndicator(color: C.maroon));
    }
    final handle = _data!.handle;
    final preview = _preview;
    final canSave = !_saving && _problem == null && (_changed || (_data!.displayName ?? '').isEmpty && preview.isNotEmpty);
    return Column(children: [
      Expanded(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          children: [
            const DesiHero(
              eyebrow: 'Your profile',
              title: 'About you',
              sub: 'This is how influencers know you. They never see your number.',
              ghost: 'Mera parichay',
              tone: DesiTone.lav,
              minHeight: 170,
            ),
            const SizedBox(height: 14),
            DesiCard(
              title: 'Your name',
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                _field('First name', _first, const Key('profile-first')),
                const SizedBox(height: 12),
                _field('Last name', _last, const Key('profile-last')),
                const SizedBox(height: 12),
                Text(
                  preview.isEmpty ? 'Name influencers see: add your first name' : 'Name influencers see: $preview',
                  key: const Key('profile-preview'),
                  style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4),
                ),
              ]),
            ),
            const SizedBox(height: 14),
            DesiCard(
              title: 'Your handle',
              tone: DesiTone.tea,
              child: Row(key: const Key('profile-handle'), children: [
                const Icon(Icons.lock_rounded, color: C.peacock, size: 22),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text((handle ?? '').isEmpty ? 'Not set yet' : '@$handle', style: t(18, w: FontWeight.w800)),
                    Text('Your handle is permanent', style: t(14, color: C.muted, w: FontWeight.w700)),
                  ]),
                ),
              ]),
            ),
            const SizedBox(height: 8),
            const DesiMogra(),
          ],
        ),
      ),
      Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
        decoration: const BoxDecoration(color: C.white, border: Border(top: BorderSide(color: C.line))),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_saveError != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(_saveError!, key: const Key('profile-error'), textAlign: TextAlign.center, style: t(15, color: C.ruby, w: FontWeight.w700)),
            ),
          ChunkyButton(key: const Key('profile-save'), label: _saving ? 'Saving…' : 'Save', height: 56, onTap: canSave ? _save : null),
        ]),
      ),
    ]);
  }

  Widget _field(String label, TextEditingController ctl, Key key) => TextField(
        key: key,
        controller: ctl,
        enabled: !_saving,
        maxLength: 30,
        textCapitalization: TextCapitalization.words,
        textInputAction: TextInputAction.next,
        style: t(16),
        decoration: InputDecoration(labelText: label, counterText: ''),
      );
}
