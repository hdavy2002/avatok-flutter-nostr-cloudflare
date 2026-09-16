
import '../../core/localization/ui_text.dart';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/motion/motion.dart';
import '../../core/ui/zine_widgets.dart';

/// Edits the creator's policy for future checkouts. Existing orders must keep
/// their immutable policy snapshot; this screen never touches entitlements,
/// orders, receipts or settlement records.
class CommercialServicePolicyScreen extends StatefulWidget {
  final String listingId;

  const CommercialServicePolicyScreen({super.key, required this.listingId});

  @override
  State<CommercialServicePolicyScreen> createState() =>
      _CommercialServicePolicyScreenState();
}

class _CommercialServicePolicyScreenState
    extends State<CommercialServicePolicyScreen> {
  bool _loading = true, _saving = false;
  String? _error;
  ListingCard? _listing;
  Map<String, dynamic> _attrs = {};
  int _refundHours = 24;
  int _cancellationHours = 24;
  int _bookingNoticeHours = 2;
  bool _reschedule = true;
  final _preparation = TextEditingController();

  @override
  void initState() {
    super.initState();
    Analytics.capture('commercial_policy_edit_opened', {
      'listing_id': widget.listingId,
    });
    _load();
  }

  @override
  void dispose() {
    _preparation.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final detail = await ListingsApi.detail(widget.listingId);
    if (!mounted) return;
    final listing = detail?.listing;
    if (listing == null ||
        (listing.kind != 'live_event' && listing.kind != 'consult')) {
      setState(() {
        _loading = false;
        _error = 'This creator service could not be loaded.';
      });
      return;
    }
    _listing = listing;
    _attrs = Map<String, dynamic>.from(listing.attrs);
    _refundHours = listing.commercialRefundWindowHours;
    _cancellationHours = listing.commercialCancellationWindowHours;
    _bookingNoticeHours = listing.commercialBookingNoticeHours;
    _reschedule = listing.commercialRescheduleAllowed;
    _preparation.text = listing.commercialPreparationInstructions;
    setState(() => _loading = false);
  }

  Future<void> _save() async {
    final listing = _listing;
    if (listing == null || _saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final attrs = Map<String, dynamic>.from(_attrs);
    if (listing.kind == 'live_event') {
      attrs['commercial_refund_window_hours'] = _refundHours;
    } else {
      attrs['commercial_cancellation_window_hours'] = _cancellationHours;
      attrs['commercial_reschedule_allowed'] = _reschedule;
      attrs['commercial_booking_notice_hours'] = _bookingNoticeHours;
      attrs['commercial_preparation_instructions'] =
          _preparation.text.trim();
      // Creator cannot weaken no-show/provider review authority from the app.
      attrs['commercial_no_show_policy'] = 'session_charged';
    }
    final ok = await ListingsApi.update(widget.listingId, {'attrs': attrs});
    if (!mounted) return;
    if (!ok) {
      setState(() {
        _saving = false;
        _error = 'Could not save the policy. Existing bookings were not changed.';
      });
      return;
    }
    Analytics.capture('commercial_policy_edited', {
      'listing_id': widget.listingId,
      'kind': listing.kind,
    });
    showAdToast(context, message: uiCopy(UiMessage.m_policy_updated_for_future_bookings_4b623d16c0));
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final listing = _listing;
    final live = listing?.kind == 'live_event';
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: live ? uiCopy(UiMessage.m_live_ticket_policy_4c796173fb) : uiCopy(UiMessage.m_consultation_policy_fad5962a45),
        markWord: 'policy',
        tag: 'future bookings',
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
          : ListView(
              padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
              children: [
                Container(
                  padding: const EdgeInsets.all(Msg.s3),
                  decoration: BoxDecoration(
                    color: AD.card,
                    borderRadius: BorderRadius.circular(Msg.rMd),
                    border: Border.all(color: AD.borderControl),
                  ),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    PhosphorIcon(
                      PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold),
                      color: AD.online,
                      size: 19,
                    ),
                    const SizedBox(width: Msg.s2),
                    Expanded(child: UiText(
                      UiMessage.m_changes_apply_only_to_future_da964378e8,
                      style: ADText.preview(c: AD.textPrimary),
                    )),
                  ]),
                ),
                const SizedBox(height: Msg.s4),
                if (live)
                  ZineDropdown<int>(
                    label: uiCopy(UiMessage.m_customer_refund_deadline_4059cf46b6),
                    value: _refundHours,
                    items: const [
                      DropdownMenuItem(value: 48, child: UiText(UiMessage.m_48_hours_before_406d1049a0)),
                      DropdownMenuItem(value: 24, child: UiText(UiMessage.m_24_hours_before_7dc76e45dd)),
                      DropdownMenuItem(value: 12, child: UiText(UiMessage.m_12_hours_before_86e15248a2)),
                      DropdownMenuItem(value: 0, child: UiText(UiMessage.m_non_refundable_9916b61a64)),
                    ],
                    onChanged: (v) => setState(() => _refundHours = v ?? 24),
                  )
                else ...[
                  ZineDropdown<int>(
                    label: uiCopy(UiMessage.m_customer_cancellation_deadline_359276e1fa),
                    value: _cancellationHours,
                    items: const [
                      DropdownMenuItem(value: 48, child: UiText(UiMessage.m_48_hours_before_406d1049a0)),
                      DropdownMenuItem(value: 24, child: UiText(UiMessage.m_24_hours_before_7dc76e45dd)),
                      DropdownMenuItem(value: 12, child: UiText(UiMessage.m_12_hours_before_86e15248a2)),
                      DropdownMenuItem(value: 0, child: UiText(UiMessage.m_non_refundable_9916b61a64)),
                    ],
                    onChanged: (v) =>
                        setState(() => _cancellationHours = v ?? 24),
                  ),
                  const SizedBox(height: Msg.s4),
                  ZineDropdown<int>(
                    label: uiCopy(UiMessage.m_minimum_booking_notice_4ade523a4d),
                    value: _bookingNoticeHours,
                    items: const [
                      DropdownMenuItem(value: 1, child: UiText(UiMessage.m_1_hour_f8b8883f0c)),
                      DropdownMenuItem(value: 2, child: UiText(UiMessage.m_2_hours_9808e0ec3c)),
                      DropdownMenuItem(value: 6, child: UiText(UiMessage.m_6_hours_4105ae3b8a)),
                      DropdownMenuItem(value: 24, child: UiText(UiMessage.m_24_hours_f0514e8df8)),
                    ],
                    onChanged: (v) =>
                        setState(() => _bookingNoticeHours = v ?? 2),
                  ),
                  const SizedBox(height: Msg.s4),
                  Row(children: [
                    Expanded(child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        UiText(UiMessage.m_allow_rescheduling_375a56532a, style: ADText.rowName()),
                        UiText(UiMessage.m_before_the_same_cancellation_deadline_89826a77c5,
                            style: ADText.preview()),
                      ],
                    )),
                    const SizedBox(width: Msg.s3),
                    ZineToggle(
                      value: _reschedule,
                      onChanged: (v) => setState(() => _reschedule = v),
                    ),
                  ]),
                  const SizedBox(height: Msg.s4),
                  ZineField(
                    controller: _preparation,
                    label: uiCopy(UiMessage.m_preparation_instructions_optional_8587c70140),
                    hint: uiCopy(UiMessage.m_what_should_the_customer_prepare_db42b5b82c),
                    maxLines: 4,
                    maxLength: 600,
                    textCapitalization: TextCapitalization.sentences,
                  ),
                  const SizedBox(height: Msg.s3),
                  UiText(
                    UiMessage.m_customer_no_show_the_booked_c8f14adead,
                    style: ADText.preview(c: AD.textSecondary),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: Msg.s3),
                  AdErrorMsg(_error!),
                ],
              ],
            ),
      bottomNavigationBar: _loading
          ? null
          : Container(
              decoration: BoxDecoration(
                color: AD.headerFooter,
                border: Border(top: BorderSide(color: AD.borderHairline)),
              ),
              child: SafeArea(
                minimum: const EdgeInsets.all(Msg.s3),
                child: AdButton(
                  label: _saving ? uiCopy(UiMessage.m_saving_23e39291d6) : uiCopy(UiMessage.m_save_policy_57ee14ce14),
                  fullWidth: true,
                  loading: _saving,
                  onPressed: _saving || listing == null ? null : _save,
                ),
              ),
            ),
    );
  }
}
