// [ADDCALL-1-UI 2026-08-06] The Add-to-call contact picker.
//
// Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` (§8 caps, §9 Phase 1).
//
// A modal bottom sheet over the live call screen. Deliberately built as a near
// twin of `forward_sheet.dart` — same grab handle, same white search field, same
// checkmark row, same single confirm bar — because this is the second multi-select
// people-picker in the app and the two should not look like different products.
// The differences are all forced by the fact that this one runs DURING a call:
//
//  * **Contacts only, no groups.** The server takes a `string[]` of uids. There is
//    no meaning to "add a group to a call" in Phase 1.
//  * **A hard cap with a live allowance.** A call holds 10 people INCLUDING the two
//    already on it, so at most 8 are selectable. The cap is enforced by REFUSING
//    the 9th tap (and saying why), not by letting the user pick 12 and then
//    failing on submit — a rejected submit after the 1:1 has been torn down is
//    the worst possible failure here.
//  * **`tel:` contacts are excluded.** A phone-only contact saved from the
//    receptionist has no AvaTOK account, so `adhoc_room.ts` would answer
//    `unknown_uid` for it. Offering it would be offering a guaranteed failure.
//  * **The peer already on the call and the user themself are excluded**, for the
//    same reason: the server adds the peer itself and rejects `peer_uid === uid`.
//
// This widget is PURE UI + selection. It performs no network call and knows
// nothing about rooms, conferences or teardown — `call_screen.dart` owns that.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'contacts.dart';

/// The product cap from spec §8, mirrored from `adhoc_room.ts`'s
/// `MAX_ADHOC_MEMBERS`. The SERVER's copy is authoritative — this one exists only
/// so the picker can stop the user before they commit, and
/// `AdhocRoomResult.maxMembers` on a `full` refusal is what wins if they diverge.
const int kAddToCallMaxParticipants = 10;

/// Opens the picker. Returns the chosen contacts, or null/empty when dismissed.
///
/// [alreadyOnCall] is how many people are already in the call (2 for a 1:1 — you
/// and the peer). [excludeUids] is everyone who must not be offered: the peer,
/// and in a later phase the people already added.
Future<List<Contact>?> showAddToCallSheet(
  BuildContext context, {
  required String callId,
  required int alreadyOnCall,
  required Set<String> excludeUids,
}) {
  Analytics.capture('addcall_picker_opened', {
    'call_id': callId,
    'escalation_id': 'addcall:$callId',
    'already_on_call': alreadyOnCall,
  });
  return showModalBottomSheet<List<Contact>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: AD.borderControl, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
    builder: (ctx) => _AddToCallSheet(
      alreadyOnCall: alreadyOnCall,
      excludeUids: excludeUids,
    ),
  );
}

class _AddToCallSheet extends StatefulWidget {
  const _AddToCallSheet({required this.alreadyOnCall, required this.excludeUids});

  final int alreadyOnCall;
  final Set<String> excludeUids;

  @override
  State<_AddToCallSheet> createState() => _AddToCallSheetState();
}

class _AddToCallSheetState extends State<_AddToCallSheet> {
  final _search = TextEditingController();
  final _selected = <String, Contact>{}; // uid → contact
  List<Contact> _contacts = [];
  bool _loading = true;
  String _query = '';

  /// How many more people may be added — the allowance the user actually sees.
  /// Clamped at 0 so a call that is somehow already at the cap shows "0 more"
  /// rather than a negative number.
  int get _allowance {
    final left = kAddToCallMaxParticipants - widget.alreadyOnCall;
    return left < 0 ? 0 : left;
  }

  bool get _atLimit => _selected.length >= _allowance;

  @override
  void initState() {
    super.initState();
    _load();
    _search.addListener(() {
      final q = _search.text.trim().toLowerCase();
      if (q != _query) setState(() => _query = q);
    });
  }

  Future<void> _load() async {
    final all = await ContactsStore().load();
    if (!mounted) return;
    setState(() {
      // Both filters are load-bearing, not tidiness: see the header comment.
      _contacts = all
          .where((c) =>
              c.uid.isNotEmpty &&
              !c.isPhoneOnly &&
              !widget.excludeUids.contains(c.uid))
          .toList();
      _loading = false;
    });
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _toggle(Contact c) {
    if (_selected.containsKey(c.uid)) {
      setState(() => _selected.remove(c.uid));
      return;
    }
    if (_atLimit) {
      // Refuse the tap and SAY why. Silently ignoring it reads as a broken row.
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              'A call can have at most $kAddToCallMaxParticipants people, so '
              'you can add ${_allowance == 1 ? '1 person' : '$_allowance people'}.')));
      Analytics.capture('addcall_picker_cap_hit', {
        'max_members': kAddToCallMaxParticipants,
        'allowance': _allowance,
      });
      return;
    }
    setState(() => _selected[c.uid] = c);
  }

  List<Contact> get _filtered => _query.isEmpty
      ? _contacts
      : _contacts
          .where((c) =>
              c.name.toLowerCase().contains(_query) ||
              c.subtitle.toLowerCase().contains(_query))
          .toList();

  @override
  Widget build(BuildContext context) {
    final contacts = _filtered;
    final n = _selected.length;
    final remaining = _allowance - n;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: Msg.s2),
        Container(
          width: 44,
          height: 5,
          decoration:
              BoxDecoration(color: AD.textFaint, borderRadius: Msg.brPill),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Row(children: [
            Text('Add to call', style: ADText.threadName()),
            const Spacer(),
            Text(
              // The allowance is always on screen, before AND after a selection,
              // so the cap is never a surprise at the moment of confirming.
              remaining <= 0
                  ? 'Limit reached'
                  : 'You can add $remaining more',
              style: ADText.preview(c: AD.textTertiary),
            ),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Container(
            decoration: BoxDecoration(
              color: AD.inputField,
              borderRadius: BorderRadius.circular(AD.rInput),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                  size: 18, color: AD.placeholderOnWhite),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _search,
                  cursorColor: AD.primaryBadge,
                  style: ADText.rowName(c: AD.textOnInput),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: Msg.s4),
                    hintText: 'Search contacts',
                    hintStyle: ADText.rowName(c: AD.placeholderOnWhite),
                  ),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(height: Msg.s1),
        Flexible(
          child: _loading
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: CircularProgressIndicator(color: AD.iconSearch))
              : contacts.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: Msg.s6),
                      child: Text(
                          _query.isEmpty
                              ? 'No AvaTOK contacts to add'
                              : 'No matches',
                          style: ADText.preview(c: AD.textSecondary)))
                  : ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                      children: [
                        for (final c in contacts) _row(c),
                      ],
                    ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s1, Msg.s4, Msg.s4),
            child: Row(children: [
              Expanded(
                child: Text(
                  // Says what will HAPPEN, not just what is ticked: this button
                  // ends the one-to-one and starts a group call, and the user
                  // should know that before they press it (spec §9 — the gap is
                  // expected in Phase 1, so it must not be a surprise).
                  n == 0
                      ? 'Select who to add'
                      : 'Start a group call with ${_names(n)}',
                  style: ADText.preview(c: AD.textTertiary),
                ),
              ),
              const SizedBox(width: Msg.s2),
              _ConfirmButton(
                enabled: n > 0,
                onTap: () =>
                    Navigator.pop(context, _selected.values.toList()),
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  String _names(int n) {
    final vals = _selected.values.toList();
    if (n == 1) return vals.first.name;
    if (n == 2) return '${vals[0].name} and ${vals[1].name}';
    return '${vals[0].name} and ${n - 1} others';
  }

  Widget _row(Contact c) {
    final on = _selected.containsKey(c.uid);
    // A row that cannot be selected still shows, dimmed, rather than vanishing
    // when the limit is reached — a list that reshuffles under the finger is
    // worse than one that greys out.
    final selectable = on || !_atLimit;
    return Opacity(
      opacity: selectable ? 1 : 0.45,
      child: InkWell(
        onTap: () => _toggle(c),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: Msg.s2),
          child: Row(children: [
            Avatar(
                seed: c.seed,
                name: c.name,
                avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl,
                size: 42),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(c.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.rowName()),
                    if (c.subtitle.isNotEmpty)
                      Text(c.subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ADText.preview(c: AD.textTertiary)),
                  ]),
            ),
            const SizedBox(width: 8),
            AnimatedContainer(
              duration: Msg.fast,
              width: 24,
              height: 24,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: on ? AD.online : Colors.transparent,
                border: Border.all(
                    color: on ? AD.online : AD.borderControl, width: 2),
              ),
              child: on
                  // White on the filled green, exactly as forward_sheet.dart's
                  // checkmark does it. `Colors.white` is a design-guard sentinel
                  // (it carries no design decision), not a raw colour literal.
                  ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                      size: 15, color: Colors.white)
                  : null,
            ),
          ]),
        ),
      ),
    );
  }
}

class _ConfirmButton extends StatelessWidget {
  const _ConfirmButton({required this.enabled, required this.onTap});

  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: AnimatedOpacity(
        duration: Msg.fast,
        opacity: enabled ? 1 : 0.4,
        child: Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: Msg.s5),
          decoration: BoxDecoration(
            color: AD.primaryBadge,
            borderRadius: Msg.brMd,
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text('Add', style: ADText.rowName(c: AD.textOnInput)),
            const SizedBox(width: Msg.s1),
            PhosphorIcon(PhosphorIcons.usersThree(PhosphorIconsStyle.fill),
                size: 17, color: AD.textOnInput),
          ]),
        ),
      ),
    );
  }
}
