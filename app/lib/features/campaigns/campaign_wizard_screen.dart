
import '../../core/localization/ui_text.dart';

import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/apps_service.dart';
import '../../core/campaigns_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import 'campaign_voice_picker.dart';

/// Multi-step outbound-campaign creation wizard (Specs/
/// OUTBOUND-AI-CALLING-CAMPAIGNS.md). Six steps — Goal, Contacts, Number,
/// Schedule & channels, Booking & handover, Review & launch — built on
/// [Stepper] (matches the rest of the app: no PageView step-indicator idiom
/// exists yet, and Stepper is the safest/most standard widget for this shape).
///
/// Talks to [CampaignsApi]. `createCampaign` / `uploadKbFile` / `launchCampaign`
/// are live Worker routes; `uploadContacts` / `searchDids` / `buyDid` are
/// client plumbing ahead of their Worker routes (per campaigns_api.dart) and
/// are guarded here so a 404 degrades to a "coming soon" note instead of
/// crashing the wizard.
///
/// NOT wired into any router/screen yet — push it explicitly once the
/// campaigns dashboard is ready:
/// `Navigator.of(context).push(MaterialPageRoute(builder: (_) => const CampaignWizardScreen()))`.
class CampaignWizardScreen extends StatefulWidget {
  const CampaignWizardScreen({super.key});
  @override
  State<CampaignWizardScreen> createState() => _CampaignWizardScreenState();
}

enum _NumberChoice { existing, fresh }

/// A file picked but not yet uploaded — bytes are staged client-side and only
/// sent to the Worker once the campaign draft exists (createCampaign returns
/// the id KB/contacts uploads need).
class _StagedFile {
  final String name;
  final Uint8List bytes;
  const _StagedFile(this.name, this.bytes);
}

class _CampaignWizardScreenState extends State<CampaignWizardScreen> {
  int _step = 0;
  bool _launching = false;
  String? _error;

  // ---- Step 1: Goal -------------------------------------------------------
  final _name = TextEditingController();
  final _agentName = TextEditingController();
  final _businessName = TextEditingController();
  final _goal = TextEditingController();
  final _offer = TextEditingController();
  final _keyFacts = TextEditingController();
  final _objections = TextEditingController();
  final _persona = TextEditingController();
  String? _languageHint; // null = auto, else an ISO code ('hi', 'en', 'ta'…)
  final List<_StagedFile> _kbFiles = [];

  // Language options for the Goal step's language list (AVA-CAMP-Q-WIZARD).
  // (label, code) — null code = Auto. English/Hindi kept first (existing
  // defaults), then common Indian languages per the task brief.
  static const List<(String, String?)> _languages = [
    ('Auto', null),
    ('English', 'en'),
    ('Hindi', 'hi'),
    ('Tamil', 'ta'),
    ('Telugu', 'te'),
    ('Bengali', 'bn'),
    ('Marathi', 'mr'),
    ('Gujarati', 'gu'),
    ('Kannada', 'kn'),
  ];

  // ---- Voice picker (AVA-CAMP-Q-WIZARD) ------------------------------------
  List<CampaignVoice> _voices = [];
  String? _selectedVoiceId;

  // ---- Connectors (AVA-CAMP-Q-WIZARD): Google Calendar (booking) + Google
  // Sheets (contacts import). Same status/connect plumbing as
  // avaapps_screen.dart's AppsService, just driven from inside the wizard.
  bool _sheetsConnected = false;

  // ---- Step 2: Contacts -----------------------------------------------------
  _StagedFile? _contactsFile;
  final _sheetLink = TextEditingController();
  String? _contactsNote;

  // ---- Step 3: Number -------------------------------------------------------
  _NumberChoice _numberChoice = _NumberChoice.existing;
  String? _didE164;
  List<DidOffer> _didOffers = const [];
  bool _didSearchLoading = false;
  bool _didSearchAvailable = true; // false once /api/dids/search 404s

  // ---- Step 4: Schedule & channels -------------------------------------------
  int _concurrency = 1;
  final _spendCap = TextEditingController();
  final _estContacts = TextEditingController(text: '100');
  static const int _windowStartMin = 600; // 10:00 IST
  static const int _windowEndMin = 1140; // 19:00 IST
  static const int _estMinutesPerCall = 3;
  static const int _ratePerMinTokens = 6;
  static const int _newDidTokens = 700;

  // ---- Step 5: Booking & handover --------------------------------------------
  bool _bookingEnabled = false;
  bool _calendarConnected = false;
  bool _connectorsChecked = false; // covers both googlecalendar + googlesheets
  bool _handoverEnabled = false;
  final _handoverNumber = TextEditingController();

  @override
  void initState() {
    super.initState();
    _spendCap.text = '$_estimatedCostTokens';
    _searchDids();
    _checkConnectors();
    _loadVoices();
  }

  @override
  void dispose() {
    _name.dispose();
    _agentName.dispose();
    _businessName.dispose();
    _goal.dispose();
    _offer.dispose();
    _keyFacts.dispose();
    _objections.dispose();
    _persona.dispose();
    _sheetLink.dispose();
    _spendCap.dispose();
    _estContacts.dispose();
    _handoverNumber.dispose();
    super.dispose();
  }

  int get _estimatedCostTokens {
    final contacts = int.tryParse(_estContacts.text.trim()) ?? 0;
    final callCost = contacts * _estMinutesPerCall * _ratePerMinTokens;
    final didCost = _numberChoice == _NumberChoice.fresh ? _newDidTokens : 0;
    return callCost + didCost;
  }

  // ---- Guarded backend lookups ------------------------------------------------

  Future<void> _searchDids() async {
    setState(() => _didSearchLoading = true);
    try {
      final offers = await CampaignsApi.searchDids();
      if (!mounted) return;
      setState(() {
        _didOffers = offers;
        _didSearchLoading = false;
      });
    } catch (_) {
      // TODO(backend): GET /api/dids/search isn't mounted yet — degrade to a
      // "coming soon" note rather than blocking the step.
      if (!mounted) return;
      setState(() {
        _didSearchAvailable = false;
        _didSearchLoading = false;
      });
    }
  }

  /// Checks both connectors the wizard cares about in one call — Google
  /// Calendar (booking, step 5) and Google Sheets (contacts import, step 2).
  /// Mirrors `avaapps_screen.dart`'s `_load()` status check; guarded so a
  /// failed lookup just leaves both connectors "not connected" instead of
  /// crashing the wizard.
  Future<void> _checkConnectors({bool fresh = false}) async {
    try {
      final connected = await AppsService.I.status(fresh: fresh);
      if (!mounted) return;
      setState(() {
        _calendarConnected = connected.contains('googlecalendar');
        _sheetsConnected = connected.contains('googlesheets');
        _connectorsChecked = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _connectorsChecked = true); // stays "not connected" on failure
    }
  }

  /// GET /api/campaigns/voices — guarded per the task brief: a 404/failure
  /// just leaves [_voices] empty and the picker shows its own "default voice"
  /// fallback message rather than crashing the wizard.
  Future<void> _loadVoices() async {
    final voices = await CampaignsApi.fetchVoices();
    if (!mounted) return;
    setState(() => _voices = voices);
  }

  /// Triggers the same Composio OAuth connect flow `avaapps_screen.dart` uses
  /// (in-app browser tab → `avatok://connected` deep link back into the app),
  /// just fired from inside the wizard instead of the AvaApps grid. [slug] is
  /// `googlecalendar` or `googlesheets`; both are checked outside the AvaApps
  /// grid's `kEnabledAppSlugs` allow-list (that set only gates which tiles are
  /// tappable on the AvaApps screen — the connect/status API itself works for
  /// any Composio toolkit slug).
  Future<void> _connectConnector(String slug, String label) async {
    try {
      final r = await AppsService.I.connectSlug(slug);
      if (r.premium) {
        _toast(uiCopy(UiMessage.m_top_up_to_connect_label_5641b1b458, {'label': (label).toString()}));
        return;
      }
      if (r.url.isEmpty) {
        // Already connected server-side — just refresh status.
        await _checkConnectors(fresh: true);
        return;
      }
      final uri = Uri.parse(r.url);
      var opened = false;
      try {
        opened = await launchUrl(uri, mode: LaunchMode.inAppBrowserView);
      } catch (_) {/* fall back below */}
      if (!opened) {
        try {
          opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
        } catch (_) {/* surfaced via snackbar below */}
      }
      if (opened) {
        _toast(uiCopy(UiMessage.m_authorize_label_you_ll_come_7ed71015be, {'label': (label).toString()}));
        // ignore: unawaited_futures
        _pollConnector(slug);
      } else {
        _toast(uiCopy(UiMessage.m_couldn_t_open_the_label_3256b4696b, {'label': (label).toString()}));
      }
    } catch (_) {
      _toast(uiCopy(UiMessage.m_couldn_t_start_the_label_edf4436e57, {'label': (label).toString()}));
    }
  }

  /// After launching the OAuth tab, poll status a few times so the
  /// green/"Connected" state appears as soon as Composio marks the account
  /// ACTIVE — same polling cadence as `avaapps_screen.dart`'s `_pollConnected`.
  Future<void> _pollConnector(String slug) async {
    for (final delay in const [
      Duration(seconds: 2),
      Duration(seconds: 3),
      Duration(seconds: 4),
      Duration(seconds: 6),
    ]) {
      await Future.delayed(delay);
      if (!mounted) return;
      try {
        final connected = await AppsService.I.status(fresh: true);
        if (!mounted) return;
        setState(() {
          _calendarConnected = connected.contains('googlecalendar');
          _sheetsConnected = connected.contains('googlesheets');
        });
        if (connected.contains(slug)) return;
      } catch (_) {/* keep polling on a transient failure */}
    }
  }

  // ---- Pickers ------------------------------------------------------------

  Future<void> _pickKbFiles() async {
    final res = await FilePicker.platform.pickFiles(
      withData: true,
      allowMultiple: true,
      type: FileType.custom,
      allowedExtensions: const ['pdf', 'doc', 'docx', 'txt', 'md'],
    );
    if (res == null) return;
    setState(() {
      for (final f in res.files) {
        if (f.bytes != null) _kbFiles.add(_StagedFile(f.name, f.bytes!));
      }
    });
  }

  void _removeKbFile(int i) => setState(() => _kbFiles.removeAt(i));

  Future<void> _pickContactsFile() async {
    final res = await FilePicker.platform.pickFiles(
      withData: true,
      type: FileType.custom,
      allowedExtensions: const ['csv', 'xlsx', 'xls'],
    );
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    setState(() {
      _contactsFile = _StagedFile(f.name, f.bytes!);
      _contactsNote = null;
    });
  }

  // ---- Step navigation ------------------------------------------------------

  void _onContinue() {
    setState(() => _error = null);
    switch (_step) {
      case 0:
        if (_name.text.trim().isEmpty) {
          setState(() => _error = 'Give the campaign a name.');
          return;
        }
        if (_goal.text.trim().isEmpty) {
          setState(() => _error = 'Describe what the agent should do on the call.');
          return;
        }
        break;
      case 2:
        if (_numberChoice == _NumberChoice.existing && _didOffers.isNotEmpty && _didE164 == null) {
          setState(() => _error = 'Pick a number, or switch to "Get a new number".');
          return;
        }
        break;
      case 3:
        final cap = int.tryParse(_spendCap.text.trim());
        if (cap == null || cap <= 0) {
          setState(() => _error = 'Enter a spend cap in tokens.');
          return;
        }
        break;
    }
    if (_step < 5) setState(() => _step += 1);
  }

  void _onBack() {
    if (_step > 0) setState(() { _step -= 1; _error = null; });
  }

  // ---- Launch ---------------------------------------------------------------

  String _compiledGoalText() {
    final parts = <String>[_goal.text.trim()];
    if (_agentName.text.trim().isNotEmpty) parts.add('Agent name: ${_agentName.text.trim()}');
    if (_offer.text.trim().isNotEmpty) parts.add('Offer: ${_offer.text.trim()}');
    if (_keyFacts.text.trim().isNotEmpty) parts.add('Key facts: ${_keyFacts.text.trim()}');
    if (_objections.text.trim().isNotEmpty) parts.add('If asked: ${_objections.text.trim()}');
    if (_persona.text.trim().isNotEmpty) parts.add('Persona notes: ${_persona.text.trim()}');
    return parts.where((p) => p.isNotEmpty).join('\n\n');
  }

  Future<void> _launch() async {
    setState(() { _launching = true; _error = null; });
    try {
      // "Get a new number" has no DID search/buy route live yet (guarded
      // above) — create the campaign without a DID; it can be assigned one
      // later once /api/dids/buy ships.
      final didE164 = _numberChoice == _NumberChoice.existing ? _didE164 : null;

      final campaign = await CampaignsApi.createCampaign(
        name: _name.text.trim(),
        goalText: _compiledGoalText(),
        spendCapTokens: int.tryParse(_spendCap.text.trim()) ?? 0,
        didE164: didE164,
        languageHint: _languageHint,
        // Prefer the picked voice id (voice picker, guarded — may be null if
        // /api/campaigns/voices isn't live yet); fall back to the free-text
        // persona field so older behavior still sends something meaningful.
        voicePersona: _selectedVoiceId ?? (_persona.text.trim().isEmpty ? null : _persona.text.trim()),
        concurrency: _concurrency,
        windowStartMin: _windowStartMin,
        windowEndMin: _windowEndMin,
      );

      for (final f in _kbFiles) {
        try {
          await CampaignsApi.uploadKbFile(campaign.id, f.name, f.bytes);
        } catch (_) {
          // Best-effort — one failed KB file shouldn't block the launch.
        }
      }

      if (_contactsFile != null) {
        try {
          await CampaignsApi.uploadContacts(campaign.id, _contactsFile!.bytes, _contactsFile!.name);
        } catch (_) {
          // TODO(backend): POST /api/campaigns/:id/contacts isn't mounted yet.
          if (mounted) {
            setState(() => _contactsNote = 'Contact upload is coming soon — add contacts once it ships.');
          }
        }
      }

      await CampaignsApi.launchCampaign(campaign.id);

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: UiText(UiMessage.m_campaign_launched_8f27b5c6ec)));
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() { _launching = false; _error = e.message; });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: UiText(UiMessage.m_couldn_t_launch_value1_778b0c4e81, params: {'value1': (e.message).toString()})));
    } catch (_) {
      if (!mounted) return;
      setState(() { _launching = false; _error = 'Something went wrong.'; });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: UiText(UiMessage.m_couldn_t_launch_check_your_72225fbe27)),
      );
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  // ---- Build ------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _header(),
      body: SafeArea(
        child: Theme(
          data: Theme.of(context).copyWith(
            colorScheme: Theme.of(context).colorScheme.copyWith(
                  primary: AD.primaryBadge,
                  secondary: AD.primaryBadge,
                ),
            canvasColor: AD.bg,
          ),
          child: Stepper(
            type: StepperType.vertical,
            currentStep: _step,
            onStepContinue: _onContinue,
            onStepCancel: _step == 0 ? null : _onBack,
            controlsBuilder: (context, details) {
              final isLast = _step == 5;
              return Padding(
                padding: const EdgeInsets.only(top: Msg.s4, bottom: Msg.s1),
                child: Row(children: [
                  if (!isLast)
                    Expanded(
                      child: AdButton(label: uiCopy(UiMessage.m_continue_31fbef1625), fullWidth: true, onPressed: details.onStepContinue),
                    ),
                  if (!isLast && _step > 0) const SizedBox(width: Msg.s3),
                  if (_step > 0)
                    Expanded(
                      child: AdButton(
                        label: uiCopy(UiMessage.m_back_76900f1bfd),
                        variant: AdButtonVariant.ghost,
                        fullWidth: true,
                        onPressed: _launching ? null : details.onStepCancel,
                      ),
                    ),
                ]),
              );
            },
            steps: [
              Step(
                title: UiText(UiMessage.m_goal_cdbf6975e8, style: ADText.rowName()),
                isActive: _step >= 0,
                state: _step > 0 ? StepState.complete : StepState.indexed,
                content: _goalStep(),
              ),
              Step(
                title: UiText(UiMessage.m_contacts_b450645deb, style: ADText.rowName()),
                isActive: _step >= 1,
                state: _step > 1 ? StepState.complete : StepState.indexed,
                content: _contactsStep(),
              ),
              Step(
                title: UiText(UiMessage.m_number_bd82cf1669, style: ADText.rowName()),
                isActive: _step >= 2,
                state: _step > 2 ? StepState.complete : StepState.indexed,
                content: _numberStep(),
              ),
              Step(
                title: UiText(UiMessage.m_schedule_channels_062b16394d, style: ADText.rowName()),
                isActive: _step >= 3,
                state: _step > 3 ? StepState.complete : StepState.indexed,
                content: _scheduleStep(),
              ),
              Step(
                title: UiText(UiMessage.m_booking_handover_77fc24fbc5, style: ADText.rowName()),
                isActive: _step >= 4,
                state: _step > 4 ? StepState.complete : StepState.indexed,
                content: _bookingStep(),
              ),
              Step(
                title: UiText(UiMessage.m_review_launch_69f2e5ad07, style: ADText.rowName()),
                isActive: _step >= 5,
                state: StepState.indexed,
                content: _reviewStep(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  PreferredSizeWidget _header() {
    return PreferredSize(
      preferredSize: const Size.fromHeight(72),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s2, Msg.s3, Msg.s4, Msg.s3),
            child: Row(children: [
              const AdBackButton(),
              const SizedBox(width: Msg.s2),
              Expanded(
                child: UiText(UiMessage.m_new_campaign_23448cb6d1, style: ADText.appTitle(),
                    maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  // ---- Step 1: Goal -------------------------------------------------------

  Widget _goalStep() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      AdField(
        controller: _name,
        label: uiCopy(UiMessage.m_campaign_name_e092a1f873),
        hint: uiCopy(UiMessage.m_e_g_diwali_sale_outreach_0444665ad1),
        textCapitalization: TextCapitalization.sentences,
      ),
      const SizedBox(height: Msg.s4),
      AdField(
        controller: _agentName,
        label: uiCopy(UiMessage.m_ai_agent_name_1fd464e974),
        hint: uiCopy(UiMessage.m_e_g_ava_riya_priya_1c0c12c9b0),
        textCapitalization: TextCapitalization.words,
      ),
      const SizedBox(height: Msg.s4),
      AdField(
        controller: _businessName,
        label: uiCopy(UiMessage.m_business_name_used_in_the_92b9aa6d8b),
        hint: uiCopy(UiMessage.m_e_g_sharma_electronics_234625d842),
        textCapitalization: TextCapitalization.words,
        onChanged: (_) => setState(() {}),
      ),
      const SizedBox(height: Msg.s3),
      _disclosurePreview(),
      const SizedBox(height: Msg.s4),
      AdField(
        controller: _goal,
        label: uiCopy(UiMessage.m_what_should_the_agent_do_171c933aed),
        hint: uiCopy(UiMessage.m_e_g_tell_customers_about_c4c11fe849),
        minLines: 3,
        maxLines: null,
        textCapitalization: TextCapitalization.sentences,
      ),
      const SizedBox(height: Msg.s4),
      UiText(UiMessage.m_more_detail_optional_5a26a91d15, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      AdField(controller: _offer, label: uiCopy(UiMessage.m_offer_0cf57c63eb), hint: uiCopy(UiMessage.m_e_g_20_off_all_fef00cc590),
          textCapitalization: TextCapitalization.sentences),
      const SizedBox(height: Msg.s3),
      AdField(controller: _keyFacts, label: uiCopy(UiMessage.m_key_facts_e4717f888f), hint: uiCopy(UiMessage.m_e_g_sale_runs_fri_bed500968d),
          minLines: 2, maxLines: null, textCapitalization: TextCapitalization.sentences),
      const SizedBox(height: Msg.s3),
      AdField(controller: _objections, label: uiCopy(UiMessage.m_objection_answers_3ff353aadc),
          hint: uiCopy(UiMessage.m_e_g_if_they_ask_16465859b0),
          minLines: 2, maxLines: null, textCapitalization: TextCapitalization.sentences),
      const SizedBox(height: Msg.s4),
      UiText(UiMessage.m_language_a4fe65264e, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final (label, code) in _languages)
          AdChip(label: label, active: _languageHint == code, onTap: () => setState(() => _languageHint = code)),
      ]),
      const SizedBox(height: Msg.s4),
      UiText(UiMessage.m_voice_87bf2bc085, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      CampaignVoicePicker(
        voices: _voices,
        selectedId: _selectedVoiceId,
        onSelected: (id) => setState(() => _selectedVoiceId = id),
      ),
      const SizedBox(height: Msg.s4),
      AdField(
        controller: _persona,
        label: uiCopy(UiMessage.m_persona_notes_optional_19152cce8e),
        hint: uiCopy(UiMessage.m_e_g_friendly_upbeat_keeps_e9d776e264),
        textCapitalization: TextCapitalization.sentences,
      ),
      const SizedBox(height: Msg.s4),
      UiText(UiMessage.m_knowledge_files_b99cd7c6ce, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      _kbFilesList(),
      const SizedBox(height: Msg.s2),
      AdChip(label: uiCopy(UiMessage.m_upload_files_pdf_doc_txt_82ab0c2a2f), onTap: _pickKbFiles),
      Padding(
        padding: const EdgeInsets.only(top: Msg.s2),
        child: UiText(UiMessage.m_files_upload_once_the_campaign_563c68f5cf, style: ADText.preview(c: AD.textTertiary)),
      ),
      if (_error != null) AdErrorMsg(_error!),
    ]);
  }

  Widget _disclosurePreview() {
    final biz = _businessName.text.trim().isEmpty ? 'your business' : _businessName.text.trim();
    return Container(
      padding: const EdgeInsets.all(Msg.s3),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.regular), size: 16, color: AD.textSecondary),
        const SizedBox(width: Msg.s2),
        Expanded(
          child: UiText(UiMessage.m_hello_this_is_ava_calling_37501bc744, params: {'biz': (biz).toString()},
              style: ADText.preview(c: AD.textSecondary)),
        ),
      ]),
    );
  }

  Widget _kbFilesList() {
    if (_kbFiles.isEmpty) {
      return UiText(UiMessage.m_no_files_yet_390ddbd1e4, style: ADText.preview(c: AD.textTertiary));
    }
    return Column(children: [
      for (var i = 0; i < _kbFiles.length; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: Msg.s2),
          child: Row(children: [
            Icon(PhosphorIcons.fileText(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
            const SizedBox(width: Msg.s2),
            Expanded(child: Text(_kbFiles[i].name, style: ADText.rowName(), overflow: TextOverflow.ellipsis)),
            IconButton(
              icon: Icon(PhosphorIcons.trash(PhosphorIconsStyle.bold), size: 16, color: AD.danger),
              onPressed: () => _removeKbFile(i),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            ),
          ]),
        ),
    ]);
  }

  /// Shared connect/connected row for a Composio connector (Google Calendar in
  /// the Booking step, Google Sheets in the Contacts step) — icon+brand color
  /// mirror `kAvaApps` in `apps_service.dart` so the same app reads the same
  /// everywhere in the app. Green "Connected" sticker when active, else an
  /// icon + "Connect" chip that fires [_connectConnector].
  Widget _connectorRow({
    required IconData icon,
    required Color color,
    required String label,
    required bool connected,
    required String slug,
  }) {
    return Container(
      padding: const EdgeInsets.all(Msg.s3),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(children: [
        Icon(icon, size: 20, color: color),
        const SizedBox(width: Msg.s3),
        Expanded(child: Text(label, style: ADText.rowName())),
        if (connected)
          AdSticker('Connected', kind: AdStickerKind.ok, icon: PhosphorIcons.check(PhosphorIconsStyle.bold))
        else
          AdChip(
            label: _connectorsChecked ? uiCopy(UiMessage.m_connect_1a2303ede0) : uiCopy(UiMessage.m_checking_ec963ffc91),
            onTap: _connectorsChecked ? () => _connectConnector(slug, label) : null,
          ),
      ]),
    );
  }

  // ---- Step 2: Contacts -----------------------------------------------------

  Widget _contactsStep() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      UiText(UiMessage.m_upload_a_spreadsheet_of_names_25d74a1a04, style: ADText.preview()),
      const SizedBox(height: Msg.s3),
      if (_contactsFile != null)
        Padding(
          padding: const EdgeInsets.only(bottom: Msg.s2),
          child: Row(children: [
            Icon(PhosphorIcons.fileText(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
            const SizedBox(width: Msg.s2),
            Expanded(child: Text(_contactsFile!.name, style: ADText.rowName(), overflow: TextOverflow.ellipsis)),
            IconButton(
              icon: Icon(PhosphorIcons.trash(PhosphorIconsStyle.bold), size: 16, color: AD.danger),
              onPressed: () => setState(() => _contactsFile = null),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            ),
          ]),
        ),
      AdChip(label: _contactsFile == null ? uiCopy(UiMessage.m_upload_excel_csv_6c9fe6d5e8) : uiCopy(UiMessage.m_change_file_1a675bfd38), onTap: _pickContactsFile),
      const SizedBox(height: Msg.s4),
      UiText(UiMessage.m_or_829e5b28af, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      AdField(
        controller: _sheetLink,
        label: uiCopy(UiMessage.m_google_sheet_link_cbdbecf56f),
        hint: 'https://docs.google.com/spreadsheets/…',
        keyboardType: TextInputType.url,
      ),
      const SizedBox(height: Msg.s3),
      UiText(
        UiMessage.m_parsing_and_validation_happen_once_f7d3eb97b7,
        style: ADText.preview(c: AD.textTertiary),
      ),
      if (_contactsNote != null) ...[
        const SizedBox(height: Msg.s3),
        AdErrorMsg(_contactsNote!),
      ],
      const SizedBox(height: Msg.s4),
      UiText(UiMessage.m_or_connect_google_sheets_e88e20bb16, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      _connectorRow(
        icon: PhosphorIcons.gridFour(PhosphorIconsStyle.regular),
        color: const Color(0xFF0F9D58), // matches kAvaApps' googlesheets tile
        label: uiCopy(UiMessage.m_google_sheets_f109802a74),
        connected: _sheetsConnected,
        slug: 'googlesheets',
      ),
      const SizedBox(height: Msg.s2),
      UiText(
        UiMessage.m_connecting_lets_ava_pull_contacts_336c8b9cc3,
        style: ADText.preview(c: AD.textTertiary),
      ),
    ]);
  }

  // ---- Step 3: Number -------------------------------------------------------

  Widget _numberStep() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _numberChoiceTile(
        choice: _NumberChoice.existing,
        title: uiCopy(UiMessage.m_use_existing_number_1957099929),
        subtitle: _didSearchLoading
            ? uiCopy(UiMessage.m_loading_numbers_1b230bf748)
            : !_didSearchAvailable
                ? uiCopy(UiMessage.m_number_provisioning_is_coming_soon_864e8f8d81)
                : _didOffers.isEmpty
                    ? uiCopy(UiMessage.m_no_numbers_available_yet_2c1a3b9f5d)
                    : uiCopy(UiMessage.m_value1_number_s_available_3af1c40819, {'value1': (_didOffers.length).toString()}),
      ),
      if (_numberChoice == _NumberChoice.existing && _didSearchAvailable && _didOffers.isNotEmpty) ...[
        const SizedBox(height: Msg.s3),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final d in _didOffers)
            AdChip(label: d.e164, active: _didE164 == d.e164, onTap: () => setState(() => _didE164 = d.e164)),
        ]),
      ],
      const SizedBox(height: Msg.s3),
      _numberChoiceTile(
        choice: _NumberChoice.fresh,
        title: uiCopy(UiMessage.m_get_a_new_number_fecb37af0d),
        subtitle: uiCopy(UiMessage.m_700_tokens_month_e471fac1e0),
      ),
      if (_error != null) AdErrorMsg(_error!),
    ]);
  }

  Widget _numberChoiceTile({required _NumberChoice choice, required String title, required String subtitle}) {
    final selected = _numberChoice == choice;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => setState(() {
        _numberChoice = choice;
        if (choice == _NumberChoice.fresh) _didE164 = null;
      }),
      child: Container(
        padding: const EdgeInsets.all(Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: selected ? AD.primaryBadge : AD.borderControl, width: 1),
        ),
        child: Row(children: [
          Container(
            width: 20, height: 20,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: selected ? AD.primaryBadge : AD.textTertiary, width: 2),
            ),
            child: selected
                ? Container(width: 10, height: 10,
                    decoration: const BoxDecoration(shape: BoxShape.circle, color: AD.primaryBadge))
                : null,
          ),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.rowName()),
              const SizedBox(height: 2),
              Text(subtitle, style: ADText.preview()),
            ]),
          ),
        ]),
      ),
    );
  }

  // ---- Step 4: Schedule & channels --------------------------------------------

  Widget _scheduleStep() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      UiText(UiMessage.m_window_19734a1b58, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      Container(
        padding: const EdgeInsets.all(Msg.s3),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.regular), size: 16, color: AD.textSecondary),
          const SizedBox(width: Msg.s2),
          UiText(UiMessage.m_10_00_19_00_ist_217e850857, style: ADText.rowName()),
        ]),
      ),
      const SizedBox(height: Msg.s4),
      UiText(UiMessage.m_concurrency_8708492f3e, style: ADText.sectionLabel()),
      const SizedBox(height: Msg.s2),
      Row(children: [
        _stepperButton(icon: PhosphorIcons.minus(PhosphorIconsStyle.bold), onTap: _concurrency > 1 ? () => setState(() => _concurrency -= 1) : null),
        SizedBox(width: 50, child: Text('$_concurrency', textAlign: TextAlign.center, style: ADText.rowName())),
        _stepperButton(icon: PhosphorIcons.plus(PhosphorIconsStyle.bold), onTap: _concurrency < 10 ? () => setState(() => _concurrency += 1) : null),
      ]),
      const SizedBox(height: Msg.s4),
      AdField(
        controller: _estContacts,
        label: uiCopy(UiMessage.m_estimated_contacts_for_the_cost_033309816a),
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        onChanged: (_) => setState(() {}),
      ),
      const SizedBox(height: Msg.s4),
      AdField(
        controller: _spendCap,
        label: uiCopy(UiMessage.m_spend_cap_tokens_required_6f1a0ffcda),
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      ),
      const SizedBox(height: Msg.s2),
      UiText(UiMessage.m_the_campaign_auto_pauses_once_17eeb34c6e, style: ADText.preview(c: AD.textTertiary)),
      if (_error != null) AdErrorMsg(_error!),
    ]);
  }

  Widget _stepperButton({required IconData icon, VoidCallback? onTap}) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s2),
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          width: 36, height: 36,
          decoration: BoxDecoration(
            color: AD.card, shape: BoxShape.circle,
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Icon(icon, size: 18, color: onTap == null ? AD.textTertiary : AD.textPrimary),
        ),
      ),
    );
  }

  // ---- Step 5: Booking & handover ---------------------------------------------

  Widget _bookingStep() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_appointment_booking_bd80edd3fa, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(
              _calendarConnected
                  ? uiCopy(UiMessage.m_ava_can_offer_and_book_24c1266560)
                  : uiCopy(UiMessage.m_connect_google_calendar_to_let_79042720d3),
              style: ADText.preview(),
            ),
          ]),
        ),
        const SizedBox(width: Msg.s2),
        _WizToggle(
          value: _bookingEnabled && _calendarConnected,
          onChanged: _calendarConnected ? (v) => setState(() => _bookingEnabled = v) : null,
        ),
      ]),
      if (!_calendarConnected) ...[
        const SizedBox(height: Msg.s3),
        _connectorRow(
          icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.regular),
          color: const Color(0xFF4285F4), // matches kAvaApps' googlecalendar tile
          label: uiCopy(UiMessage.m_google_calendar_b074310e91),
          connected: _calendarConnected,
          slug: 'googlecalendar',
        ),
      ],
      const SizedBox(height: Msg.s5),
      const Divider(color: AD.borderHairline),
      const SizedBox(height: Msg.s4),
      Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_human_handover_643b43481c, style: ADText.rowName()),
            const SizedBox(height: 2),
            UiText(UiMessage.m_transfer_the_call_to_a_d9640024a4, style: ADText.preview()),
          ]),
        ),
        const SizedBox(width: Msg.s2),
        _WizToggle(value: _handoverEnabled, onChanged: (v) => setState(() => _handoverEnabled = v)),
      ]),
      if (_handoverEnabled) ...[
        const SizedBox(height: Msg.s3),
        AdField(
          controller: _handoverNumber,
          label: uiCopy(UiMessage.m_handover_number_ee08660ddd),
          hint: '+91…',
          keyboardType: TextInputType.phone,
        ),
      ],
    ]);
  }

  // ---- Step 6: Review & launch -------------------------------------------------

  Widget _reviewStep() {
    final contacts = int.tryParse(_estContacts.text.trim()) ?? 0;
    final cap = int.tryParse(_spendCap.text.trim()) ?? 0;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _summaryRow('Name', _name.text.trim().isEmpty ? '—' : _name.text.trim()),
      _summaryRow('Agent name', _agentName.text.trim().isEmpty ? '—' : _agentName.text.trim()),
      _summaryRow('Goal', _goal.text.trim().isEmpty ? '—' : _goal.text.trim()),
      _summaryRow('Language', _languages.firstWhere((l) => l.$2 == _languageHint, orElse: () => _languages.first).$1),
      _summaryRow('Voice', _selectedVoiceLabel()),
      _summaryRow('Knowledge files', '${_kbFiles.length}'),
      _summaryRow(
        'Contacts',
        _contactsFile != null
            ? _contactsFile!.name
            : (_sheetLink.text.trim().isEmpty ? 'None added' : 'Google Sheet link'),
      ),
      _summaryRow(
        'Number',
        _numberChoice == _NumberChoice.existing ? (_didE164 ?? 'Not selected') : 'New number (700 tokens/month)',
      ),
      _summaryRow('Window', '10:00–19:00 IST'),
      _summaryRow('Concurrency', '$_concurrency'),
      _summaryRow('Spend cap', '$cap tokens'),
      _summaryRow('Booking', _bookingEnabled && _calendarConnected ? 'Enabled' : 'Off'),
      _summaryRow(
        'Handover',
        _handoverEnabled
            ? (_handoverNumber.text.trim().isEmpty ? 'Enabled (no number set)' : _handoverNumber.text.trim())
            : 'Off',
      ),
      const SizedBox(height: Msg.s4),
      Container(
        padding: const EdgeInsets.all(Msg.s4),
        decoration: BoxDecoration(
          color: AD.primaryBadge.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.primaryBadge.withValues(alpha: 0.40), width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          UiText(UiMessage.m_estimated_cost_9ccba222f8, style: ADText.sectionLabel(c: AD.primaryBadge)),
          const SizedBox(height: Msg.s2),
          UiText(
            UiMessage.m_estimatedcosttokens_tokens_contacts_contacts_est_0ef0163f6a, params: {'estimatedCostTokens': (_estimatedCostTokens).toString(), 'contacts': (contacts).toString(), 'estMinutesPerCall': (_estMinutesPerCall).toString(), 'ratePerMinTokens': (_ratePerMinTokens).toString(), 'value5': (_numberChoice == _NumberChoice.fresh ? ' + $_newDidTokens for the new number' : '').toString()},
            style: ADText.preview(c: AD.textSecondary),
          ),
        ]),
      ),
      const SizedBox(height: Msg.s4),
      if (_error != null) ...[AdErrorMsg(_error!), const SizedBox(height: Msg.s3)],
      AdButton(
        label: _launching ? uiCopy(UiMessage.m_launching_a6f90e03c4) : uiCopy(UiMessage.m_launch_campaign_72c83f4577),
        fullWidth: true,
        fontSize: 16,
        loading: _launching,
        onPressed: _launching ? null : _launch,
      ),
    ]);
  }

  String _selectedVoiceLabel() {
    if (_selectedVoiceId == null) return 'Default';
    for (final v in _voices) {
      if (v.id == _selectedVoiceId) return v.name;
    }
    return _selectedVoiceId!;
  }

  Widget _summaryRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s2),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 110, child: Text(label, style: ADText.sectionLabel())),
        Expanded(child: Text(value, style: ADText.rowName())),
      ]),
    );
  }
}

/// Dark v2 inline toggle — mirrors `_AdToggle` in
/// settings/sections/business_agent_section.dart (private there, so this
/// screen carries its own copy rather than importing a private class).
class _WizToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _WizToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: Msg.fast,
        width: 52, height: 30,
        padding: const EdgeInsets.all(Msg.s1),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: Msg.fast,
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 22, height: 22,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
          ),
        ),
      ),
    );
  }
}
