import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ai_media_jobs.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';

/// [AVA-MEDIA-JOB-1] Reusable card for an [AiMediaJob] — image, document and
/// audio kinds all render through this ONE widget so the four lifecycle states
/// (Working / Ready / Failed / Cancelled) always look and behave the same way
/// regardless of which capability produced the job.
///
/// Why this exists (Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md
/// Part VI §36-§37, §43.6): the previous "ava_status" chip was one generic pill
/// with a spinner and no other visual state — a failure and a success looked
/// the same as "still going" until something else happened to replace it, and
/// `chat_thread.dart` swept every such chip on the next unrelated Ava reply, so
/// a still-running job could disappear with no trace. This widget makes the
/// four states impossible to confuse (different chrome, icon, colour and copy
/// per state — not four shades of the same chip) and is keyed ONLY by
/// `job.jobId` (see [keyFor]), so the caller can add/update/remove exactly one
/// card without touching any other message in the thread.
///
/// This widget is presentation-only: it renders [job] and calls back. All
/// networking lives in [AiMediaJobRepository]; the caller (Wave 3, wiring this
/// into `chat_thread.dart`) owns fetching bytes/thumbnails and passes them in.
class AiMediaJobCard extends StatelessWidget {
  const AiMediaJobCard({
    super.key,
    required this.job,
    this.width = 240,
    this.thumbnailBytes,
    this.thumbnailWidget,
    this.onTapOpen,
    this.onDownload,
    this.onShare,
    this.onSaveToLibrary,
    this.onCopyResult,
    this.onDelete,
    this.onRetry,
    this.onCancel,
  });

  final AiMediaJob job;
  final double width;

  /// Succeeded-image thumbnail bytes (already decrypted/decoded by the
  /// caller). Only used for [AiMediaJobKind.imageGenerate]; ignored otherwise.
  final Uint8List? thumbnailBytes;

  /// Escape hatch: a fully custom preview widget (e.g. a cached-network image,
  /// a PDF first-page render) for the succeeded state, taking priority over
  /// [thumbnailBytes] when provided.
  final Widget? thumbnailWidget;

  /// Open the artifact full-screen / in its viewer. Always shown when set,
  /// for every kind in the succeeded state.
  final VoidCallback? onTapOpen;

  /// Download the ORIGINAL/full-resolution artifact (never a CDN thumbnail
  /// rendition — Part VI §37: "must fetch the original R2 object").
  final VoidCallback? onDownload;
  final VoidCallback? onShare;

  /// "Save to AvaStorage".
  final VoidCallback? onSaveToLibrary;

  /// Doc jobs only ("Copy result", §38). Omit for image/audio kinds.
  final VoidCallback? onCopyResult;

  /// Delete the RESULT artifact (never the original source media).
  final VoidCallback? onDelete;

  /// Shown only in the Failed state. Re-submits the job (see
  /// [AiMediaJobRepository.retry]); the caller decides what to do with the
  /// newly returned job (typically: swap this card's key to the new job_id).
  final VoidCallback? onRetry;

  /// Shown only in the Working state, when set.
  final VoidCallback? onCancel;

  /// Stable widget key so a caller can find/replace/remove exactly this card
  /// by job identity — never by list position, never by "the last ava_status
  /// row". Wave 3: key every `AiMediaJobCard` with this, and match updates
  /// from `AiMediaJobRepository.updates` by `update.jobId` alone.
  static Key keyFor(String jobId) => ValueKey('ai_media_job_$jobId');

  @override
  Widget build(BuildContext context) {
    return switch (job.status) {
      AiMediaJobStatus.queued || AiMediaJobStatus.running => _WorkingCard(
          job: job, width: width, onCancel: onCancel,
        ),
      AiMediaJobStatus.succeeded => _ReadyCard(
          job: job,
          width: width,
          thumbnailBytes: thumbnailBytes,
          thumbnailWidget: thumbnailWidget,
          onTapOpen: onTapOpen,
          onDownload: onDownload,
          onShare: onShare,
          onSaveToLibrary: onSaveToLibrary,
          onCopyResult: onCopyResult,
          onDelete: onDelete,
        ),
      AiMediaJobStatus.failed => _FailedCard(job: job, width: width, onRetry: onRetry),
      AiMediaJobStatus.cancelled => _CancelledCard(job: job, width: width, onRetry: onRetry),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared per-kind copy/icon helpers
// ─────────────────────────────────────────────────────────────────────────────

IconData _kindIcon(AiMediaJobKind k) => switch (k) {
      AiMediaJobKind.imageGenerate => PhosphorIcons.image(PhosphorIconsStyle.duotone),
      AiMediaJobKind.docSummarize => PhosphorIcons.fileText(PhosphorIconsStyle.duotone),
      AiMediaJobKind.docTranslate => PhosphorIcons.translate(PhosphorIconsStyle.duotone),
      AiMediaJobKind.audioTranscribe => PhosphorIcons.fileAudio(PhosphorIconsStyle.duotone),
      AiMediaJobKind.audioTranslate => PhosphorIcons.waveform(PhosphorIconsStyle.duotone),
    };

String _workingLabel(AiMediaJob job) {
  if (job.label.isNotEmpty) return job.label;
  return switch (job.kind) {
    AiMediaJobKind.imageGenerate => 'Working on your image…',
    AiMediaJobKind.docSummarize => 'Preparing summary…',
    AiMediaJobKind.docTranslate => 'Translating your document…',
    AiMediaJobKind.audioTranscribe => 'Converting to text…',
    AiMediaJobKind.audioTranslate => 'Translating audio…',
  };
}

String _readyLabel(AiMediaJob job) {
  if (job.label.isNotEmpty) return job.label;
  return switch (job.kind) {
    AiMediaJobKind.imageGenerate => 'Image ready',
    AiMediaJobKind.docSummarize => 'Summary ready',
    AiMediaJobKind.docTranslate => 'Translation ready',
    AiMediaJobKind.audioTranscribe => 'Transcript ready',
    AiMediaJobKind.audioTranslate => 'Translated audio ready',
  };
}

/// Maps a SAFE error code (never a raw provider string — the server contract
/// guarantees `error_code` is vetted, see ai_media_jobs.dart's file doc) to
/// user-facing copy. An unrecognized/missing code still gets a truthful,
/// non-technical fallback rather than leaking `null` or a code string to the UI.
String _friendlyError(AiMediaJob job) {
  final noun = job.kind.displayNoun;
  return switch (job.errorCode) {
    'provider_timeout' => "This took too long and didn't finish.",
    'provider_unavailable' => 'The AI service is unavailable right now.',
    'unsupported_format' => "This file type isn't supported for this action.",
    'input_too_large' => 'This file is too large for this action.',
    'insufficient_balance' => 'Not enough AvaCoins to finish this.',
    'cancelled_by_user' => 'Cancelled.',
    _ => "Couldn't finish your $noun.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared chrome
// ─────────────────────────────────────────────────────────────────────────────

class _CardShell extends StatelessWidget {
  const _CardShell({
    required this.width,
    required this.borderColor,
    required this.child,
    this.fill = AD.card,
  });
  final double width;
  final Color borderColor;
  final Color fill;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: borderColor, width: 1),
        boxShadow: const [],
      ),
      child: child,
    );
  }
}

Widget _pillButton({
  required String label,
  required VoidCallback? onPressed,
  required Color color,
  IconData? icon,
}) {
  return GestureDetector(
    onTap: onPressed,
    behavior: HitTestBehavior.opaque,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: Msg.brSm,
        border: Border.all(color: color, width: 1),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          PhosphorIcon(icon, size: 14, color: color),
          const SizedBox(width: 5),
        ],
        Text(label, style: ADText.statCaption(c: color).copyWith(fontWeight: FontWeight.w700)),
      ]),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKING — accent-bordered card, spinner, safe progress label, optional Cancel.
// ─────────────────────────────────────────────────────────────────────────────

class _WorkingCard extends StatelessWidget {
  const _WorkingCard({required this.job, required this.width, this.onCancel});
  final AiMediaJob job;
  final double width;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final accent = AD.iconSearch; // blue = "in progress", distinct from ready/failed/cancelled
    return _CardShell(
      width: width,
      borderColor: accent,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          SizedBox(
            width: 20, height: 20,
            child: CircularProgressIndicator(strokeWidth: 2, color: accent),
          ),
          const SizedBox(width: 10),
          PhosphorIcon(_kindIcon(job.kind), size: 18, color: accent),
          const SizedBox(width: 8),
          Expanded(
            child: Text(_workingLabel(job),
                maxLines: 2, overflow: TextOverflow.ellipsis,
                style: ADText.rowName(c: AD.textPrimary).copyWith(fontStyle: FontStyle.italic)),
          ),
        ]),
        if (job.progress != null) ...[
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: Msg.brPill,
            child: LinearProgressIndicator(
              value: job.progress!.clamp(0.0, 1.0),
              minHeight: 4,
              backgroundColor: AD.borderControl,
              valueColor: AlwaysStoppedAnimation(accent),
            ),
          ),
        ],
        if (onCancel != null) ...[
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: _pillButton(label: 'Cancel', onPressed: onCancel, color: AD.textSecondary),
          ),
        ],
      ]),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// READY — the finished artifact. Image kind gets a visual thumbnail; other
// kinds get a typed row. Overflow menu carries Open/Download/Share/Save/Delete
// (only the actions the caller actually wired via non-null callbacks).
// ─────────────────────────────────────────────────────────────────────────────

class _ReadyCard extends StatelessWidget {
  const _ReadyCard({
    required this.job,
    required this.width,
    this.thumbnailBytes,
    this.thumbnailWidget,
    this.onTapOpen,
    this.onDownload,
    this.onShare,
    this.onSaveToLibrary,
    this.onCopyResult,
    this.onDelete,
  });

  final AiMediaJob job;
  final double width;
  final Uint8List? thumbnailBytes;
  final Widget? thumbnailWidget;
  final VoidCallback? onTapOpen;
  final VoidCallback? onDownload;
  final VoidCallback? onShare;
  final VoidCallback? onSaveToLibrary;
  final VoidCallback? onCopyResult;
  final VoidCallback? onDelete;

  bool get _hasVisual =>
      job.kind == AiMediaJobKind.imageGenerate && (thumbnailWidget != null || thumbnailBytes != null);

  List<PopupMenuEntry<String>> _menuItems() {
    final items = <PopupMenuEntry<String>>[];
    if (onTapOpen != null) items.add(const PopupMenuItem(value: 'open', child: Text('Open')));
    if (onCopyResult != null) items.add(const PopupMenuItem(value: 'copy', child: Text('Copy result')));
    if (onDownload != null) items.add(const PopupMenuItem(value: 'download', child: Text('Download')));
    if (onShare != null) items.add(const PopupMenuItem(value: 'share', child: Text('Share')));
    if (onSaveToLibrary != null) {
      items.add(const PopupMenuItem(value: 'save', child: Text('Save to AvaStorage')));
    }
    if (onDelete != null) items.add(const PopupMenuItem(value: 'delete', child: Text('Delete')));
    return items;
  }

  void _onMenuSelected(String v) {
    switch (v) {
      case 'open':
        onTapOpen?.call();
        break;
      case 'copy':
        onCopyResult?.call();
        break;
      case 'download':
        onDownload?.call();
        break;
      case 'share':
        onShare?.call();
        break;
      case 'save':
        onSaveToLibrary?.call();
        break;
      case 'delete':
        onDelete?.call();
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final accent = AD.bubbleOutPlay; // green = "done"
    final menu = _menuItems();

    if (_hasVisual) {
      // Image-forward layout, matching the existing finished-Ava-image bubble
      // convention (see chat_thread.dart::_avaImageBubble) so a generated image
      // looks the same whether it arrives via the job card or the legacy path
      // during the migration window.
      return Container(
        width: width,
        margin: const EdgeInsets.only(bottom: 8),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AD.rListCard),
          child: Stack(children: [
            GestureDetector(
              onTap: onTapOpen,
              child: thumbnailWidget ??
                  Image.memory(thumbnailBytes!, width: width, fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Container(
                            width: width, height: width,
                            color: AD.mediaPlaceholderBg,
                            alignment: Alignment.center,
                            child: PhosphorIcon(PhosphorIcons.imageBroken(PhosphorIconsStyle.bold),
                                color: AD.mediaPlaceholderLabel, size: 28),
                          )),
            ),
            if (menu.isNotEmpty)
              Positioned(
                top: 6, right: 6,
                child: DecoratedBox(
                  decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                  child: PopupMenuButton<String>(
                    tooltip: 'Image options',
                    icon: Icon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 18, color: Colors.white),
                    padding: EdgeInsets.zero,
                    onSelected: _onMenuSelected,
                    itemBuilder: (_) => menu,
                  ),
                ),
              ),
            Positioned(
              left: 6, bottom: 6,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.6), borderRadius: Msg.brPill),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 12, color: accent),
                  const SizedBox(width: 4),
                  Text('READY', style: ADText.statCaption(c: Colors.white)),
                ]),
              ),
            ),
          ]),
        ),
      );
    }

    // Typed row — document / audio kinds.
    return _CardShell(
      width: width,
      borderColor: accent,
      child: GestureDetector(
        onTap: onTapOpen,
        behavior: HitTestBehavior.opaque,
        child: Row(children: [
          Container(
            width: 40, height: 40,
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(AD.rBadge),
              border: Border.all(color: accent, width: 1),
            ),
            child: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), color: accent, size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(_readyLabel(job), maxLines: 2, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
              const SizedBox(height: 3),
              Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(_kindIcon(job.kind), size: 12, color: AD.textTertiary),
                const SizedBox(width: 4),
                Text(job.kind.displayNoun, style: ADText.statCaption(c: AD.textTertiary)),
              ]),
            ]),
          ),
          if (menu.isNotEmpty)
            PopupMenuButton<String>(
              tooltip: 'Options',
              icon: Icon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 18, color: AD.textSecondary),
              padding: EdgeInsets.zero,
              onSelected: _onMenuSelected,
              itemBuilder: (_) => menu,
            ),
        ]),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FAILED — danger-tinted, safe copy only (never a raw provider string), Retry.
// ─────────────────────────────────────────────────────────────────────────────

class _FailedCard extends StatelessWidget {
  const _FailedCard({required this.job, required this.width, this.onRetry});
  final AiMediaJob job;
  final double width;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return _CardShell(
      width: width,
      borderColor: AD.danger,
      fill: AD.danger.withValues(alpha: 0.08),
      child: Row(children: [
        Container(
          width: 40, height: 40,
          decoration: BoxDecoration(
            color: AD.danger.withValues(alpha: 0.16),
            borderRadius: BorderRadius.circular(AD.rBadge),
            border: Border.all(color: AD.danger, width: 1),
          ),
          child: Icon(PhosphorIcons.warning(PhosphorIconsStyle.fill), color: AD.danger, size: 20),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(_friendlyError(job), maxLines: 2, overflow: TextOverflow.ellipsis,
                style: ADText.rowName(c: AD.danger)),
            if ((job.errorCode ?? '').isNotEmpty) ...[
              const SizedBox(height: 2),
              Text('Error: ${job.errorCode}', style: ADText.statCaption(c: AD.textTertiary)),
            ],
          ]),
        ),
        if (onRetry != null) ...[
          const SizedBox(width: 8),
          _pillButton(
            label: 'Retry',
            onPressed: onRetry,
            color: AD.danger,
            icon: PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold),
          ),
        ],
      ]),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLED — muted/grey, distinct from Failed (not an error) and from Working
// (not in progress). Optional Retry (re-submits fresh, see repository.retry).
// ─────────────────────────────────────────────────────────────────────────────

class _CancelledCard extends StatelessWidget {
  const _CancelledCard({required this.job, required this.width, this.onRetry});
  final AiMediaJob job;
  final double width;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return _CardShell(
      width: width,
      borderColor: AD.borderControl,
      fill: AD.card.withValues(alpha: 0.6),
      child: Row(children: [
        Container(
          width: 40, height: 40,
          decoration: BoxDecoration(
            color: AD.textTertiary.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(AD.rBadge),
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Icon(PhosphorIcons.xCircle(PhosphorIconsStyle.bold), color: AD.textTertiary, size: 20),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('Cancelled', style: ADText.rowName(c: AD.textSecondary)),
            const SizedBox(height: 2),
            Text('This ${job.kind.displayNoun} job was cancelled.',
                maxLines: 2, overflow: TextOverflow.ellipsis, style: ADText.statCaption(c: AD.textTertiary)),
          ]),
        ),
        if (onRetry != null) ...[
          const SizedBox(width: 8),
          _pillButton(label: 'Retry', onPressed: onRetry, color: AD.textSecondary),
        ],
      ]),
    );
  }
}
