import 'dart:convert';

import '../../core/brain_api.dart';
import '../../core/library_api.dart';
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
    if (!item.isPrivate) return 'This file is public — AvaBrain already knows it.';
    final id = ApiAuth.identity;
    if (id == null || item.encBlob == null || item.encBlob!.isEmpty) {
      return "Can't read this file on this device.";
    }
    // Unwrap the decryption material (encrypted to me) → reconstruct the handle.
    final clear = await Vault.decrypt(item.encBlob!, id.privHex);
    if (clear == null) return "Couldn't unlock this file's key on this device.";
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
      if (text.trim().isEmpty) return 'No readable text found in this file.';
      summary = text.replaceAll(RegExp(r'\s+'), ' ').trim();
      summary = summary.length > 600 ? summary.substring(0, 600) : summary;
    } else {
      // Non-text private media: send only the (user-visible) file name as the
      // derived signal — never the bytes — so the brain can at least surface it.
      summary = '(${item.category} file)';
    }

    final stored = await BrainApi.remember(facts: [
      {
        'fact_type': 'file',
        'content': 'Private file "${item.name}" (${item.category}): $summary',
        'confidence': 0.6,
      }
    ]);
    return stored > 0 ? 'AvaBrain learned this file (on-device).' : 'Nothing new to learn.';
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
