/// [HF-SUPPORT-APP] Customer side of the support tickets (contract: HF-SUPPORT-CONTRACT.md, worker `/api/hf/support/*`).
/// Parsing is tolerant: a missing key is a safe default, and times may arrive as epoch milliseconds, epoch seconds or text.
library;

/// The eight topics of the Contact Support form: slug (sent to the server) and the label shown on the chip.
class SupportTopic {
  const SupportTopic(this.slug, this.label);

  final String slug;
  final String label;
}

const List<SupportTopic> kSupportTopics = <SupportTopic>[
  SupportTopic('calls', 'Calls'),
  SupportTopic('wallet', 'Wallet & top-ups'),
  SupportTopic('withdraw', 'Withdraw to UPI'),
  SupportTopic('bookings', 'Bookings'),
  SupportTopic('influencer', 'Influencer account'),
  SupportTopic('app', 'App problem'),
  SupportTopic('report', 'Report someone'),
  SupportTopic('other', 'Other'),
];

/// Label for a category slug; the slug itself for one this app does not know.
String supportTopicLabel(String slug) {
  for (final t in kSupportTopics) {
    if (t.slug == slug) return t.label;
  }
  return slug;
}

/// Epoch milliseconds from a number (seconds or milliseconds) or a date text (a D1 time without a zone is UTC). Null when unreadable.
int? supportMs(Object? v) {
  if (v is num) {
    final n = v.toInt();
    return n < 100000000000 ? n * 1000 : n;
  }
  if (v is String && v.trim().isNotEmpty) {
    final s = v.trim();
    final asNum = num.tryParse(s);
    if (asNum != null) return supportMs(asNum);
    var text = s.contains(' ') && !s.contains('T') ? s.replaceFirst(' ', 'T') : s;
    final hasZone = text.endsWith('Z') || RegExp(r'[+-]\d{2}:?\d{2}$').hasMatch(text);
    if (!hasZone) text = '${text}Z';
    return DateTime.tryParse(text)?.millisecondsSinceEpoch;
  }
  return null;
}

/// The four colours of a ticket's status chip.
enum SupportTone { replied, open, solved, closed }

SupportTone supportToneOf(String status) => switch (status) {
      'waiting' => SupportTone.replied,
      'solved' => SupportTone.solved,
      'closed' || 'spam' || 'trash' => SupportTone.closed,
      _ => SupportTone.open,
    };

/// What the customer sees for a status, if the server did not send its own label.
String supportStatusLabel(String status) => switch (status) {
      'waiting' => 'We replied',
      'solved' => 'Solved',
      'closed' || 'spam' || 'trash' => 'Closed',
      _ => 'Open',
    };

/// One row of My tickets.
class SupportTicket {
  const SupportTicket({
    required this.number,
    this.subject = '',
    this.category = '',
    this.status = 'open',
    this.statusLabel = '',
    this.preview = '',
    this.updatedAt,
    this.unread = false,
  });

  /// `HF-10234`
  final String number;
  final String subject;
  final String category;
  final String status;
  final String statusLabel;
  final String preview;

  /// Epoch ms.
  final int? updatedAt;
  final bool unread;

  String get label => statusLabel.isNotEmpty ? statusLabel : supportStatusLabel(status);
  SupportTone get tone => supportToneOf(status);

  factory SupportTicket.fromJson(Map<String, dynamic> j) => SupportTicket(
        number: (j['number'] ?? '').toString(),
        subject: (j['subject'] ?? '').toString(),
        category: (j['category'] ?? '').toString(),
        status: (j['status'] ?? 'open').toString(),
        statusLabel: (j['statusLabel'] ?? '').toString(),
        preview: (j['preview'] ?? '').toString(),
        updatedAt: supportMs(j['updatedAt']),
        unread: j['unread'] == true || j['unread'] == 1,
      );

  static List<SupportTicket> listFrom(Object? raw) {
    if (raw is! List) return const <SupportTicket>[];
    return [
      for (final e in raw)
        if (e is Map && (e['number'] ?? '').toString().isNotEmpty) SupportTicket.fromJson(Map<String, dynamic>.from(e)),
    ];
  }
}

/// A file on a message.
class SupportAttachment {
  const SupportAttachment({required this.id, this.name = '', this.size = 0, this.contentType = ''});

  final String id;
  final String name;
  final int size;
  final String contentType;

  bool get isImage {
    if (contentType.startsWith('image/')) return true;
    final n = name.toLowerCase();
    return n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.webp') || n.endsWith('.gif');
  }

  bool get isPdf => contentType == 'application/pdf' || name.toLowerCase().endsWith('.pdf');

  factory SupportAttachment.fromJson(Map<String, dynamic> j) {
    final s = j['size'];
    return SupportAttachment(
      id: (j['id'] ?? '').toString(),
      name: (j['name'] ?? '').toString(),
      size: s is num ? s.toInt() : 0,
      contentType: (j['contentType'] ?? '').toString(),
    );
  }
}

/// One message of a ticket. [author] is `customer | support | system`.
class SupportMessage {
  const SupportMessage({
    required this.id,
    required this.author,
    this.authorName = '',
    this.text = '',
    this.signature = '',
    this.createdAt,
    this.attachments = const <SupportAttachment>[],
  });

  final String id;
  final String author;
  final String authorName;
  final String text;

  /// Optional separate signature text (name, role, address). Empty when the server puts the signature inside [text].
  final String signature;
  final int? createdAt;
  final List<SupportAttachment> attachments;

  bool get fromCustomer => author == 'customer';
  bool get fromSystem => author == 'system';

  factory SupportMessage.fromJson(Map<String, dynamic> j) {
    var text = (j['text'] ?? '').toString().trim();
    if (text.isEmpty && j['html'] is String) {
      // Only an html body came: drop the tags rather than show markup.
      text = (j['html'] as String)
          .replaceAll(RegExp(r'<br\s*/?>|</p>', caseSensitive: false), '\n')
          .replaceAll(RegExp(r'<[^>]*>'), '')
          .replaceAll('&nbsp;', ' ')
          .replaceAll('&amp;', '&')
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>')
          .trim();
    }
    final att = <SupportAttachment>[];
    final raw = j['attachments'];
    if (raw is List) {
      for (final e in raw) {
        if (e is Map && (e['id'] ?? '').toString().isNotEmpty) att.add(SupportAttachment.fromJson(Map<String, dynamic>.from(e)));
      }
    }
    return SupportMessage(
      id: (j['id'] ?? '').toString(),
      author: (j['author'] ?? 'support').toString(),
      authorName: (j['authorName'] ?? '').toString(),
      text: text,
      signature: (j['signature'] ?? '').toString().trim(),
      createdAt: supportMs(j['createdAt']),
      attachments: att,
    );
  }
}

/// `GET /api/hf/support/tickets/:number`: the ticket and its whole thread (internal notes are never sent).
class SupportThread {
  const SupportThread({required this.ticket, required this.messages, this.createdAt, this.canReopen = false});

  final SupportTicket ticket;
  final List<SupportMessage> messages;
  final int? createdAt;
  final bool canReopen;

  bool get hasSupportReply => messages.any((m) => m.author == 'support');

  factory SupportThread.fromJson(Map<String, dynamic> j) {
    final t = j['ticket'];
    final tm = t is Map ? Map<String, dynamic>.from(t) : <String, dynamic>{};
    final msgs = <SupportMessage>[];
    final raw = j['messages'];
    if (raw is List) {
      for (final e in raw) {
        if (e is Map) msgs.add(SupportMessage.fromJson(Map<String, dynamic>.from(e)));
      }
    }
    return SupportThread(
      ticket: SupportTicket.fromJson(tm),
      messages: msgs,
      createdAt: supportMs(tm['createdAt']),
      canReopen: tm['canReopen'] == true,
    );
  }
}

/// `POST /api/hf/support/attachments` answer.
class UploadedAttachment {
  const UploadedAttachment({required this.id, this.name = '', this.size = 0});

  final String id;
  final String name;
  final int size;
}
