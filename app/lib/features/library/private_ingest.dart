import '../../core/localization/ui_text.dart';
import 'dart:convert';

import '../../core/brain_api.dart';
import '../../core/library_api.dart';
import '../../core/account_key.dart';
import '../../core/vault.dart';
import '../../identity/identity.dart';
import '../../core/api_auth.dart';
import '../avatok/media.dart';

/// Private / E2E-file opt-in for AvaBrain. Default OFF: the server NEVER ingests
/// these. When the user explicitly opts a file in, extraction happens ON-DEVICE
/// (where the decryption key lives) and only DERIVED, non-reversible data — a
/// short summary — is sent to the brain via /api/brain/remember. The plaintext
/// bytes and the AES key never leave the device. (Rulebook E2E boundary.)
class PrivateIngest {
  /// Returns a human-readable result string, or throws on hard failure.
  static Future<String> ingest(LibraryItem item) async {
    if (!item.isPrivate) return uiCopy(UiMessage.m_this_file_is_public_avabrain_21c62795ce);
    final id = ApiAuth.identity;
    if (id == null || item.encBlob == null || item.encBlob!.isEmpty) {
      return uiCopy(UiMessage.m_can_t_read_this_file_0398ec0ca4);
    }
    // Unwrap the decryption material (encrypted to me) → reconstruct the handle.
    final keyMat = await AccountKey.I.ensureHex();
    final clear = keyMat == null ? null : await Vault.decrypt(item.encBlob!, keyMat);
    if (clear == null) return uiCopy(UiMessage.m_couldn_t_unlock_this_file_cd96dd05da);
    final mat = jsonDecode(clear) as Map<String, dynamic>;
    final media = ChatMedia(
      kind: _kindFor(item.category),
      id: item.key,
      keyB64: mat['k'].toString(),
      nonceB64: mat['n'].toString(),
      macB64: mat['mac'].toString(),
      contentType: item.mime,
      name: item.name,
      size: item.size,
    );

    // Decrypt on-device and extract text (documents/text only for now; on-device
    // image captioning is a later capability). Derive a bounded summary.
    String summary;
    if (item.category == 'document' || item.mime.startsWith('text/')) {
      final bytes = await MediaService.downloadAndDecrypt(media);
      String text;
      try { text = utf8.decode(bytes); } catch (_) { text = ''; }
      if (text.trim().isEmpty) return uiCopy(UiMessage.m_no_readable_text_found_in_c1c3227fd8);
      summary = text.replaceAll(RegExp(r'\s+'), ' ').trim();
      summary = summary.length > 600 ? summary.substring(0, 600) : summary;
    } else {
      // Non-text private media: send only the (user-visible) file name as the
      // derived signal — never the bytes — so the brain can at least surface it.
      summary = '(${item.category} file)';
    }

    final stored = await BrainApi.remember(facts: [
      {
        'fact_type': uiCopy(UiMessage.m_file_3b9c358f36),
        'content': uiCopy(UiMessage.m_private_file_value1_value2_summary_44cec0c4e7, {'value1': (item.name).toString(), 'value2': (item.category).toString(), 'summary': (summary).toString()}),
        'confidence': 0.6,
      }
    ]);
    return stored > 0 ? uiCopy(UiMessage.m_avabrain_learned_this_file_on_7207079c44) : uiCopy(UiMessage.m_nothing_new_to_learn_4659c6fab7);
  }

  static MediaKind _kindFor(String category) {
    switch (category) {
      case 'image': return MediaKind.image;
      case 'video': return MediaKind.video;
      case 'audio': return MediaKind.audio;
      default: return MediaKind.file;
    }
  }
}
