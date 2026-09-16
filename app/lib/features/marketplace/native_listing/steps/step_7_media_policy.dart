import '../../../../core/cached_image.dart';

import '../../../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../../core/ui/avatok_dark.dart';

import 'shared_widgets.dart';

typedef ListingUpload = Future<String?> Function(XFile file,
    {required bool facePhoto});

class ListingStep7PhotosPolicy extends StatefulWidget {
  final dynamic draft;
  final DraftPatch onPatch;
  final ListingUpload? onUpload;
  final ValueChanged<String>? onRemoveCover;
  final String? error;
  const ListingStep7PhotosPolicy(
      {super.key,
      required this.draft,
      required this.onPatch,
      this.onUpload,
      this.onRemoveCover,
      this.error});
  @override
  State<ListingStep7PhotosPolicy> createState() =>
      _ListingStep7PhotosPolicyState();
}

class _ListingStep7PhotosPolicyState extends State<ListingStep7PhotosPolicy> {
  bool _uploading = false;
  final _picker = ImagePicker();
  Future<void> _pick({required bool face}) async {
    if (widget.onUpload == null || _uploading) return;
    final file = await _picker.pickImage(
        source: ImageSource.gallery, maxWidth: 2200, imageQuality: 88);
    if (file == null) return;
    setState(() => _uploading = true);
    try {
      final url = await widget.onUpload!(file, facePhoto: face);
      if (url != null && mounted) {
        if (face)
          widget.onPatch({'face_photo': url});
        else
          widget.onPatch({
            'cover_media': [
              ...draftList(widget.draft, 'cover_media'),
              {'type': 'image', 'url': url}
            ]
          });
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return LayoutBuilder(
      builder: (context, constraints) => Center(
          child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ListingSection(
                        title: uiCopy(UiMessage.m_your_face_required_a8f444623c),
                        hint:
                            uiCopy(UiMessage.m_used_only_as_a_private_2640b7186a),
                        child: Row(children: [
                          _thumb(
                              textValue(draftValue(widget.draft, 'face_photo')),
                              'No photo'),
                          const SizedBox(width: 12),
                          Expanded(
                              child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                fullWidthButton(
                                    label: draftValue(
                                                widget.draft, 'face_photo') ==
                                            null
                                        ? uiCopy(UiMessage.m_upload_your_photo_8c58ac4a34)
                                        : uiCopy(UiMessage.m_replace_photo_94ae980dc8),
                                    onPressed: widget.onUpload == null
                                        ? null
                                        : () => _pick(face: true),
                                    loading: _uploading),
                                const SizedBox(height: 4),
                                const UiText(
                                    UiMessage.m_one_clear_forward_facing_jpg_305ad8bb5d)
                              ]))
                        ])),
                    if (widget.error != null) ...[
                      const SizedBox(height: 8),
                      statusMessage(widget.error!, error: true)
                    ],
                    const SizedBox(height: 24),
                    ListingSection(
                        title: uiCopy(UiMessage.m_photos_optional_up_to_5_801bd47163),
                        hint:
                            uiCopy(UiMessage.m_these_appear_below_your_poster_a1b38b6f79),
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Wrap(spacing: 8, runSpacing: 8, children: [
                                ...draftList(widget.draft, 'cover_media')
                                    .map((item) {
                                  final m = draftMap(item);
                                  return _cover(
                                      m['url']?.toString() ?? '',
                                      () => widget.onRemoveCover
                                          ?.call(m['url']?.toString() ?? ''));
                                }),
                                if (draftList(widget.draft, 'cover_media')
                                        .length <
                                    5)
                                  OutlinedButton.icon(
                                      onPressed: widget.onUpload == null
                                          ? null
                                          : () => _pick(face: false),
                                      icon: Icon(
                                          PhosphorIcons.imageSquare(PhosphorIconsStyle.regular)),
                                      label: const UiText(UiMessage.m_add_photo_c0660be883))
                              ]),
                              const SizedBox(height: 16),
                              ListingField(
                                  label: uiCopy(UiMessage.m_video_url_optional_38aa236ced),
                                  value: textValue(
                                      draftValue(widget.draft, 'video_url')),
                                  hint: 'https://…',
                                  keyboardType: TextInputType.url,
                                  onChanged: (v) =>
                                      widget.onPatch({'video_url': v})),
                            ])),
                    const SizedBox(height: 24),
                    ListingSection(
                        title: uiCopy(UiMessage.m_policy_and_access_83391d83cf),
                        child: Column(children: [
                          ListingField(
                              label: uiCopy(UiMessage.m_location_15b61974b2),
                              value: textValue(
                                  draftValue(widget.draft, 'location')),
                              hint: uiCopy(UiMessage.m_city_or_online_5bda2c3937),
                              onChanged: (v) =>
                                  widget.onPatch({'location': v})),
                          const SizedBox(height: 8),
                          SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              title: const UiText(UiMessage.m_adults_only_2171a8cb74),
                              value: draftValue(
                                      widget.draft, 'adults_only', false) ==
                                  true,
                              onChanged: (v) =>
                                  widget.onPatch({'adults_only': v})),
                          if (textValue(draftValue(widget.draft, 'kind')) ==
                              'live_event')
                            ListingField(
                                label: uiCopy(UiMessage.m_refund_window_hours_f0f3deae45),
                                value: textValue(draftValue(widget.draft,
                                    'commercial_refund_window_hours', 24)),
                                keyboardType: TextInputType.number,
                                onChanged: (v) => widget.onPatch({
                                      'commercial_refund_window_hours':
                                          int.tryParse(v) ?? 0
                                    })),
                          if (textValue(draftValue(widget.draft, 'kind')) ==
                              'consult') ...[
                            ListingField(
                                label: uiCopy(UiMessage.m_cancellation_window_hours_b7e5fd894a),
                                value: textValue(draftValue(
                                    widget.draft,
                                    'commercial_cancellation_window_hours',
                                    24)),
                                keyboardType: TextInputType.number,
                                onChanged: (v) => widget.onPatch({
                                      'commercial_cancellation_window_hours':
                                          int.tryParse(v) ?? 0
                                    })),
                            SwitchListTile(
                                contentPadding: EdgeInsets.zero,
                                title: const UiText(UiMessage.m_allow_rescheduling_375a56532a),
                                value: draftValue(
                                        widget.draft,
                                        'commercial_reschedule_allowed',
                                        true) ==
                                    true,
                                onChanged: (v) => widget.onPatch(
                                    {'commercial_reschedule_allowed': v})),
                            ListingField(
                                label: uiCopy(UiMessage.m_booking_notice_hours_d2d544a3f8),
                                value: textValue(draftValue(widget.draft,
                                    'commercial_booking_notice_hours', 6)),
                                keyboardType: TextInputType.number,
                                onChanged: (v) => widget.onPatch({
                                      'commercial_booking_notice_hours':
                                          int.tryParse(v) ?? 0
                                    })),
                          ],
                        ])),
                  ])))); }
  Widget _thumb(String url, String empty) => Container(
      width: 96,
      height: 96,
      decoration: BoxDecoration(
          color: AD.inputField,
          border: Border.all(color: Colors.black),
          borderRadius: BorderRadius.circular(AD.rImage)),
      child: url.isEmpty
          ? Center(child: Text(empty, textAlign: TextAlign.center))
          : ClipRRect(
              borderRadius: BorderRadius.circular(AD.rImage),
              child: CachedThumb(url: url, px: 256,
                  
                  fit: BoxFit.cover,
                  fallback:
                      Icon(PhosphorIcons.imageSquare(PhosphorIconsStyle.regular)))));
  Widget _cover(String url, VoidCallback remove) => Stack(children: [
        _thumb(url, 'No image'),
        Positioned(
            right: 0,
            top: 0,
            child: IconButton(
                onPressed: remove,
                icon: CircleAvatar(
                    radius: 12, child: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 14))))
      ]);
}
