part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// [CHAT-THREAD-SPLIT-2] Wallpaper picker, save-contact banner, tel footer and pin banner.
extension _ChatThreadBanners on _ChatThreadScreenState {




  void _pickWallpaper() {
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Chat wallpaper', style: ADText.threadName()),
          const SizedBox(height: 12),
          Wrap(spacing: 12, runSpacing: 12, children: [
            for (final id in kWallpaperOrder)
              GestureDetector(
                onTap: () async {
                  await WallpaperStore().set(_convKey!, id == 'default' ? '' : id);
                  if (mounted) { setState(() => _wallpaperId = id); Navigator.pop(ctx); }
                },
                child: Container(
                  width: 64, height: 64,
                  decoration: BoxDecoration(
                      gradient: _gradientFor(id), borderRadius: BorderRadius.circular(Msg.rMd),
                      border: Border.all(
                          color: _wallpaperId == id ? AD.textPrimary : AD.textTertiary,
                          width: _wallpaperId == id ? 3 : 2)),
                ),
              ),
          ]),
        ]))));
  }


  /// Open the "Save to contacts" sheet for an unknown caller, prefilled with
  /// their number. On success the affordances disappear and the header repaints
  /// with the chosen name.
  Future<void> _saveUnknownContact({String source = 'thread_menu'}) async {
    if (_telPhone.isEmpty) return;
    final saved = await showSavePhoneContactSheet(context, phone: _telPhone, source: source);
    if (saved != null && mounted) {
      setState(() => _callerSaved = true);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Saved ${saved.name}'),
        duration: const Duration(seconds: 2),
      ));
    }
  }


  /// Dismissible banner shown atop an unknown-number thread inviting the owner
  /// to save the caller as a contact.
  Widget _saveContactBanner() => Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 16, color: AD.iconVideo),
          const SizedBox(width: 8),
          Expanded(child: Text('Unknown number · ${formatTelDisplay(_telPhone)}',
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ADText.preview(c: AD.textPrimary))),
          GestureDetector(
            onTap: () => _saveUnknownContact(source: 'thread_banner'),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: AD.card,
                borderRadius: BorderRadius.circular(Msg.rSm),
                border: Border.all(color: AD.borderControl, width: 2),
              ),
              child: Text('Save', style: ADText.statCaption()),
            ),
          ),
          const SizedBox(width: 6),
          GestureDetector(onTap: () => setState(() => _saveBannerDismissed = true),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 15, color: AD.textSecondary)),
          const SizedBox(width: 8),
        ]),
      );


  /// Read-only footer for an unknown-number voicemail thread.
  Widget _telFooter() => Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(top: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(PhosphorIcons.voicemail(PhosphorIconsStyle.fill), size: 15, color: AD.textTertiary),
          const SizedBox(width: 8),
          Flexible(child: Text(
              _callerSaved
                  ? 'Voicemail record · this caller isn’t on AvaTOK'
                  : 'Voicemail record from an unknown number',
              style: ADText.preview(c: AD.textSecondary))),
          if (!_callerSaved) ...[
            const SizedBox(width: 10),
            GestureDetector(
              onTap: () => _saveUnknownContact(source: 'thread_footer'),
              child: Text('Save contact', style: ADText.statCaption(c: AD.iconSearch)),
            ),
          ],
        ]),
      );


  Widget _pinBanner() => Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.pushPin(PhosphorIconsStyle.fill), size: 15, color: AD.iconSearch),
          const SizedBox(width: 8),
          Expanded(child: Text('Pinned: ${_pinned!['text'] ?? ''}',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview(c: AD.textPrimary))),
          GestureDetector(onTap: _unpin,
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 15, color: AD.textSecondary)),
          const SizedBox(width: 8),
        ]),
      );
}
