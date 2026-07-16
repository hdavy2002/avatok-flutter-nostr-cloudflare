import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avatar_cache.dart';
import '../../core/group_store.dart';
import '../../core/profile_store.dart';
import '../../core/ui/avatok_dark.dart';
import '../../sync/group_api.dart';
import '../profile/avatar_crop_screen.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';

/// Create a group: name it, pick members from contacts. Chat-only — AvaTok has
/// no group video calls (those live in AvaConsult).
class NewGroupScreen extends StatefulWidget {
  final List<Contact> contacts;
  const NewGroupScreen({super.key, required this.contacts});
  @override
  State<NewGroupScreen> createState() => _NewGroupScreenState();
}

class _NewGroupScreenState extends State<NewGroupScreen> {
  final _name = TextEditingController();
  final Set<String> _picked = {};

  // [AVAGRP-ICON-1] A group photo is now COMPULSORY (owner request 2026-07-17):
  // "part of creating groups is adding a group photo". _photoBytes gates
  // _canCreate; the upload itself is kicked off at PICK time (not at Create
  // time) so a slow upload doesn't sit on the critical path of tapping Create —
  // by the time the user has named the group and picked members, the upload has
  // usually already finished. _photoUpload is the in-flight/completed future;
  // _create awaits it if the user is unusually fast.
  Uint8List? _photoBytes;
  String? _photoUrl;
  Future<String?>? _photoUpload;
  bool _photoUploading = false;
  bool _photoUploadFailed = false;

  // Set once GroupApi.create() succeeds, so a retry (after the photo failed to
  // attach post-create) re-tries ONLY the photo instead of creating a second
  // group — see _create()/_applyGroupPhoto().
  Group? _createdGroup;

  @override
  void dispose() { _name.dispose(); super.dispose(); }

  bool get _canCreate =>
      _name.text.trim().isNotEmpty && _picked.isNotEmpty && _photoBytes != null && !_photoUploadFailed;

  /// Only real AvaTOK accounts can be group members — phone-only receptionist
  /// contacts (no account) are excluded from the picker.
  List<Contact> get _selectable =>
      widget.contacts.where((c) => !c.isPhoneOnly && c.uid.isNotEmpty).toList();

  bool _creating = false;

  /// [AVAGRP-ICON-1] Bottom sheet mirroring group_info_screen._editGroupPhoto —
  /// same crop screen, same /upload/public bucket, so the CDN transform and
  /// on-device cache work identically for a group photo picked at creation time.
  Future<void> _choosePhoto() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.menu,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined, color: AD.textPrimary),
            title: Text('Take photo', style: ADText.rowName()),
            onTap: () { Navigator.pop(ctx); _pickCropUpload(ImageSource.camera); },
          ),
          ListTile(
            leading: const Icon(Icons.photo_library_outlined, color: AD.textPrimary),
            title: Text('Choose from gallery', style: ADText.rowName()),
            onTap: () { Navigator.pop(ctx); _pickCropUpload(ImageSource.gallery); },
          ),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  Future<void> _pickCropUpload(ImageSource source) async {
    try {
      final x = await ImagePicker().pickImage(source: source, maxWidth: 1600, imageQuality: 92);
      if (x == null) return;
      final bytes = await x.readAsBytes();
      if (!mounted) return;
      final cropped = await Navigator.push<Uint8List?>(
          context, MaterialPageRoute(builder: (_) => AvatarCropScreen(imageBytes: bytes)));
      if (cropped == null || !mounted) return;
      setState(() {
        _photoBytes = cropped;
        _photoUrl = null;
        _photoUploading = true;
        _photoUploadFailed = false;
      });
      Analytics.capture('new_group_photo_picked', {});
      final upload = Directory.uploadAvatar(cropped);
      _photoUpload = upload;
      final url = await upload;
      if (!mounted) return;
      if (url == null) {
        setState(() { _photoUploading = false; _photoUploadFailed = true; });
        Analytics.capture('new_group_photo_upload_failed', {});
        return;
      }
      // Seed the cache with the bytes we already hold so the picker preview and
      // (once the thread opens) the header both paint immediately.
      await AvatarCache.putBytes(url, 192, cropped);
      if (!mounted) return;
      setState(() { _photoUploading = false; _photoUrl = url; _photoUploadFailed = false; });
      Analytics.capture('new_group_photo_upload_succeeded', {});
    } catch (_) {
      if (mounted) setState(() { _photoUploading = false; _photoUploadFailed = true; });
      Analytics.capture('new_group_photo_upload_failed', {'reason': 'exception'});
    }
  }

  Future<void> _create() async {
    if (_creating) return;
    // The group already exists (create() succeeded on an earlier tap but
    // attaching the photo failed) — retry ONLY the photo, never re-create.
    if (_createdGroup != null) {
      setState(() => _creating = true);
      await _applyGroupPhoto(_createdGroup!);
      return;
    }
    setState(() => _creating = true);
    // The photo is compulsory (_canCreate enforces it), but the upload started
    // at pick time may still be in flight if the user was very fast — wait for
    // it rather than creating a group with no photo to attach.
    var url = _photoUrl;
    if ((url == null || url.isEmpty) && _photoUpload != null) {
      url = await _photoUpload;
    }
    if (!mounted) return;
    if (url == null || url.isEmpty) {
      setState(() { _creating = false; _photoUploadFailed = true; });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Group photo failed to upload — try picking it again.')));
      return;
    }
    _photoUrl = url;
    // Members are Clerk uids (Contact.uid). Phone-only callers have no account
    // and can't be group members, so they're excluded.
    final memberUids = widget.contacts
        .where((c) => _picked.contains(c.uid) && !c.isPhoneOnly && c.uid.isNotEmpty)
        .map((c) => c.uid)
        .toList();
    // Create the group SERVER-SIDE so membership exists in D1 — this is what makes
    // messages fan out to everyone and makes the group appear (with an offline
    // push) for the people just added.
    final g = await GroupApi.create(_name.text.trim(), memberUids);
    if (g == null) {
      if (mounted) {
        setState(() => _creating = false);
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not create the group — try again')));
      }
      return;
    }
    _createdGroup = g;
    // Announce so every added member is notified (chat line + offline banner) and
    // the group surfaces on their device.
    final myName = (await ProfileStore().load()).displayName;
    GroupApi.announce(g.id, myName.isEmpty ? 'created the group' : '$myName created the group');
    Analytics.capture('group_created_photo_status', {'gid': g.id, 'had_photo': true});
    await _applyGroupPhoto(g);
  }

  /// [AVAGRP-ICON-1] Attach the already-uploaded photo URL to the just-created
  /// group via GroupApi.setAvatar (no new endpoint — the same call group_info's
  /// photo editor uses). If it fails, the GROUP STILL EXISTS: don't silently drop
  /// the photo or leave the user stuck on a spinner — surface a retryable error
  /// and stay on this screen so a retry can reuse the same group id + url.
  Future<void> _applyGroupPhoto(Group g) async {
    final url = _photoUrl;
    var finalGroup = g;
    if (url != null && url.isNotEmpty) {
      final updated = await GroupApi.setAvatar(g.id, url);
      if (updated != null) {
        finalGroup = updated;
      } else {
        Analytics.capture('group_avatar_set_after_create_failed', {'gid': g.id});
        if (mounted) {
          setState(() => _creating = false);
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: const Text('Group created, but the photo failed to save.'),
            action: SnackBarAction(label: 'Retry', onPressed: _create),
            duration: const Duration(seconds: 6),
          ));
        }
        return; // stay put; _createdGroup keeps the id so a retry doesn't duplicate the group
      }
    }
    if (!mounted) return;
    final chat = Chat(
      name: finalGroup.name, seed: 'group-${finalGroup.id}',
      last: 'Group created · ${finalGroup.members.length} members',
      time: 'now', group: true, members: finalGroup.members.length, gid: finalGroup.id,
      // [AVAGRP-ICON-1] So the thread header shows the photo immediately instead
      // of falling back to initials until the next sync.
      avatarUrl: finalGroup.avatarUrl,
    );
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)));
  }

  @override
  Widget build(BuildContext context) {
    final canCreate = _canCreate && !_creating;
    return Scaffold(
      backgroundColor: AD.bg,
      body: Column(
        children: [
          // Inline dark v2 header: back button + title + the ONE primary
          // (teal) Create action.
          Container(
            decoration: const BoxDecoration(
              color: AD.headerFooter,
              border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 16, 12),
                child: Row(children: [
                  GestureDetector(
                    onTap: () => Navigator.of(context).maybePop(),
                    child: Container(
                      width: 42, height: 42,
                      decoration: BoxDecoration(
                        color: AD.card,
                        shape: BoxShape.circle,
                        border: Border.all(color: AD.borderControl, width: 1),
                      ),
                      child: Center(child: PhosphorIcon(
                          PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                          size: 20, color: AD.textPrimary)),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(child: Text('New group', style: ADText.appTitle())),
                  _createButton(canCreate),
                ]),
              ),
            ),
          ),
          // [AVAGRP-ICON-1] Compulsory group photo. Shown ABOVE the name field so
          // the requirement is visible before the user invests time filling in a
          // name and picking members — not discovered only once Create is greyed
          // out with no explanation (owner request 2026-07-17).
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 4),
            child: Center(child: _photoPicker()),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
            child: _nameField(),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 4),
              child: Text('ADD MEMBERS', style: ADText.sectionLabel()),
            ),
          ),
          Expanded(
            child: _selectable.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        Container(
                          width: 72, height: 72,
                          decoration: BoxDecoration(
                            color: AD.card,
                            borderRadius: BorderRadius.circular(AD.rListCard),
                            border: Border.all(color: AD.borderControl, width: 1),
                          ),
                          child: Center(child: PhosphorIcon(
                              PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                              size: 32, color: AD.textTertiary)),
                        ),
                        const SizedBox(height: 14),
                        Text('Add contacts first to build a group',
                            textAlign: TextAlign.center,
                            style: ADText.preview(c: AD.textSecondary)),
                      ]),
                    ),
                  )
                : ListView.builder(
                    itemCount: _selectable.length,
                    itemBuilder: (_, i) {
                      final c = _selectable[i];
                      final on = _picked.contains(c.uid);
                      return CheckboxListTile(
                        value: on,
                        activeColor: AD.newGroup,
                        checkColor: Colors.white,
                        side: const BorderSide(color: AD.borderControl, width: 2),
                        controlAffinity: ListTileControlAffinity.trailing,
                        onChanged: (v) => setState(() =>
                            v == true ? _picked.add(c.uid) : _picked.remove(c.uid)),
                        secondary: Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: AD.borderAvatar, width: 2),
                          ),
                          child: Avatar(seed: c.seed, name: c.name, size: 42),
                        ),
                        title: Text(c.name, style: ADText.rowName()),
                        subtitle: c.handle.isNotEmpty
                            ? Text(c.atHandle, style: ADText.preview())
                            : null,
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  /// The primary teal "Create" pill; disabled = card fill + faint label.
  Widget _createButton(bool enabled) {
    final fill = enabled ? AD.newGroup : AD.card;
    final fg = enabled ? Colors.white : AD.textTertiary;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: enabled ? _create : null,
        borderRadius: BorderRadius.circular(100),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(100),
            border: enabled ? null : Border.all(color: AD.borderControl, width: 1),
          ),
          child: Text(_creating ? '…' : 'Create', style: ADText.rowName(c: fg)),
        ),
      ),
    );
  }

  /// White dark-v2 input field with a leading teal glyph cell.
  Widget _nameField() => Container(
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: BorderRadius.circular(AD.rInput),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(children: [
          Container(
            width: 48,
            constraints: const BoxConstraints(minHeight: 52),
            color: AD.newGroup,
            alignment: Alignment.center,
            child: PhosphorIcon(PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                size: 20, color: Colors.white),
          ),
          Expanded(
            child: TextField(
              controller: _name,
              onChanged: (_) => setState(() {}),
              cursorColor: AD.newGroup,
              style: ADText.rowName(c: AD.textOnInput),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Group name',
                hintStyle: ADText.rowName(c: AD.placeholderOnWhite),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
              ),
            ),
          ),
        ]),
      );

  /// [AVAGRP-ICON-1] Tappable circular photo target — required before a group
  /// can be created. Ring + camera glyph when empty (an obvious "add this"
  /// affordance, not just a disabled Create button with no explanation);
  /// preview + edit pencil once a photo is picked; spinner while it uploads;
  /// a red retry ring if the upload failed.
  Widget _photoPicker() {
    final hasPhoto = _photoBytes != null;
    final ringColor = _photoUploadFailed
        ? AD.danger
        : (hasPhoto ? AD.borderAvatar : AD.newGroup);
    return Column(mainAxisSize: MainAxisSize.min, children: [
      GestureDetector(
        onTap: _photoUploading ? null : _choosePhoto,
        child: Stack(clipBehavior: Clip.none, children: [
          Container(
            width: 84, height: 84,
            decoration: BoxDecoration(
              color: AD.card,
              shape: BoxShape.circle,
              border: Border.all(color: ringColor, width: 2),
              boxShadow: AD.overlayShadow,
            ),
            child: _photoUploading
                ? const Center(
                    child: SizedBox(width: 22, height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AD.primaryBadge)))
                : (hasPhoto
                    ? ClipOval(child: Image.memory(_photoBytes!, width: 84, height: 84, fit: BoxFit.cover))
                    : Center(child: PhosphorIcon(
                        PhosphorIcons.camera(PhosphorIconsStyle.bold), size: 26, color: AD.newGroup))),
          ),
          if (!_photoUploading)
            Positioned(
              right: -2, bottom: -2,
              child: Container(
                padding: const EdgeInsets.all(5),
                decoration: BoxDecoration(
                  color: _photoUploadFailed ? AD.danger : AD.newGroup,
                  shape: BoxShape.circle,
                  border: Border.all(color: AD.bg, width: 2),
                ),
                child: Icon(hasPhoto ? Icons.edit : Icons.add, size: 13, color: Colors.white),
              ),
            ),
        ]),
      ),
      const SizedBox(height: 8),
      Text(
        _photoUploadFailed
            ? 'Upload failed — tap to try again'
            : (hasPhoto ? 'Group photo' : 'Add group photo · required'),
        style: ADText.preview(c: _photoUploadFailed ? AD.danger : AD.textSecondary),
      ),
    ]);
  }
}
