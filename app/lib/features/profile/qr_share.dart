import 'dart:io';
import 'dart:typed_data';

import 'package:barcode/barcode.dart';
import 'package:image/image.dart' as img;
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';

/// Builds, shares, downloads and prints a branded "Find me on AvaTOK" QR card.
///
/// ONE PDF layout is the single source of truth for both the printable sheet and
/// the rasterised JPEG, so Download and Print always look identical (owner
/// request 2026-06-29). Sharing sends the QR as an IMAGE (not a website link), so
/// WhatsApp/etc. show the QR card — never a link-preview card.
class QrShare {
  static const _title = 'Find me on AvaTOK';

  static pw.Document _buildDoc({required String link, required String name, required String number}) {
    final doc = pw.Document();
    doc.addPage(pw.Page(
      pageFormat: PdfPageFormat.a6,
      build: (ctx) => pw.Center(
        child: pw.Container(
          padding: const pw.EdgeInsets.all(20),
          decoration: pw.BoxDecoration(
            color: PdfColors.white,
            border: pw.Border.all(color: PdfColors.black, width: 2),
            borderRadius: pw.BorderRadius.circular(16),
          ),
          child: pw.Column(mainAxisSize: pw.MainAxisSize.min, children: [
            pw.Text(_title, style: pw.TextStyle(fontSize: 18, fontWeight: pw.FontWeight.bold)),
            pw.SizedBox(height: 16),
            pw.BarcodeWidget(
              barcode: Barcode.qrCode(),
              data: link,
              width: 190,
              height: 190,
              color: PdfColors.black,
            ),
            pw.SizedBox(height: 16),
            if (name.isNotEmpty)
              pw.Text(name, style: pw.TextStyle(fontSize: 15, fontWeight: pw.FontWeight.bold)),
            if (number.isNotEmpty) ...[
              pw.SizedBox(height: 4),
              pw.Text(number, style: const pw.TextStyle(fontSize: 13, color: PdfColors.blue800)),
            ],
            pw.SizedBox(height: 12),
            pw.Text('avatok.ai', style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey600)),
          ]),
        ),
      ),
    ));
    return doc;
  }

  /// Rasterise the card to JPEG bytes (falls back to PNG bytes if JPEG encoding
  /// fails for any reason).
  static Future<Uint8List> jpegBytes({required String link, required String name, required String number}) async {
    final doc = _buildDoc(link: link, name: name, number: number);
    final raster = await Printing.raster(await doc.save(), dpi: 220).first;
    final png = await raster.toPng();
    final decoded = img.decodePng(png);
    if (decoded == null) return png;
    return Uint8List.fromList(img.encodeJpg(decoded, quality: 92));
  }

  static Future<File> _writeTemp(Uint8List bytes, String fileName) async {
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}/$fileName');
    await f.writeAsBytes(bytes, flush: true);
    return f;
  }

  /// Share the QR as an IMAGE. The deep link is carried as text so a tap still
  /// opens AvaTOK → Add Contact (with the Play Store fallback on the web side).
  static Future<void> share({required String link, required String name, required String number}) async {
    try {
      final jpg = await jpegBytes(link: link, name: name, number: number);
      final f = await _writeTemp(jpg, 'avatok-qr.jpg');
      Analytics.capture('qr_card_action', {'action': 'share', 'has_number': number.isNotEmpty});
      await Share.shareXFiles(
        [XFile(f.path, mimeType: 'image/jpeg')],
        text: '$_title — ${[name, number].where((s) => s.isNotEmpty).join(' · ')}\n$link',
      );
    } catch (e) {
      Analytics.capture('qr_card_action', {'action': 'share', 'error': e.toString()});
      rethrow;
    }
  }

  /// Save the JPEG to the device (Downloads if available, else app documents).
  /// Returns the saved file path.
  static Future<String> download({required String link, required String name, required String number}) async {
    final jpg = await jpegBytes(link: link, name: name, number: number);
    Directory? dir;
    try { dir = await getDownloadsDirectory(); } catch (_) {}
    dir ??= await getApplicationDocumentsDirectory();
    final stamp = DateTime.now().millisecondsSinceEpoch;
    final f = File('${dir.path}/avatok-qr-$stamp.jpg');
    await f.writeAsBytes(jpg, flush: true);
    Analytics.capture('qr_card_action', {'action': 'download'});
    return f.path;
  }

  /// Print the card (same layout as the JPEG) so it can be posted at a business.
  static Future<void> printCard({required String link, required String name, required String number}) async {
    final doc = _buildDoc(link: link, name: name, number: number);
    Analytics.capture('qr_card_action', {'action': 'print'});
    await Printing.layoutPdf(onLayout: (_) async => doc.save());
  }
}
