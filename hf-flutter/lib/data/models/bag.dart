/// [HF-CHANNEL-APP-1] One line of the fan's bag: a merch product with the colour and size she picked, how many, and the unit
/// price the page showed (whole paise; the server re-prices at checkout). Saved on the phone per account ([BagStore]).
class BagLine {
  const BagLine({
    required this.productId,
    required this.hostSlug,
    required this.hostName,
    required this.productSlug,
    required this.title,
    required this.qty,
    required this.unitPaise,
    this.imageUrl,
    this.colour = '',
    this.colourHex = '',
    this.size = '',
    this.category = '',
    this.maxQty = 3,
  });

  factory BagLine.fromJson(Map<String, dynamic> j) {
    int i(Object? v) => v is num ? v.round() : int.tryParse('$v') ?? 0;
    String s(Object? v) => v is String ? v : (v == null ? '' : '$v');
    final img = j['imageUrl'];
    return BagLine(
      productId: s(j['productId']),
      hostSlug: s(j['hostSlug']),
      hostName: s(j['hostName']),
      productSlug: s(j['productSlug']),
      title: s(j['title']),
      qty: i(j['qty']) < 1 ? 1 : i(j['qty']),
      unitPaise: i(j['unitPaise']),
      imageUrl: img is String && img.isNotEmpty ? img : null,
      colour: s(j['colour']),
      colourHex: s(j['colourHex']),
      size: s(j['size']),
      category: s(j['category']),
      maxQty: i(j['maxQty']) > 0 ? i(j['maxQty']) : 3,
    );
  }

  final String productId;
  final String hostSlug;
  final String hostName;
  final String productSlug;
  final String title;
  final int qty;
  final int unitPaise;
  final String? imageUrl;
  final String colour;

  /// `#rrggbb` of the picked colour, for the little swatch; empty when the product has no colours.
  final String colourHex;

  /// Empty for a product that has no sizes (a mug).
  final String size;
  final String category;

  /// How many of this one a fan may buy at once (the server allows 1 to 3).
  final int maxQty;

  /// Two lines are the same line when product, colour and size match.
  String get key => '$productId|$colour|$size';

  int get totalPaise => unitPaise * qty;

  BagLine withQty(int q) => BagLine(
        productId: productId,
        hostSlug: hostSlug,
        hostName: hostName,
        productSlug: productSlug,
        title: title,
        qty: q,
        unitPaise: unitPaise,
        imageUrl: imageUrl,
        colour: colour,
        colourHex: colourHex,
        size: size,
        category: category,
        maxQty: maxQty,
      );

  Map<String, Object?> toJson() => {
        'productId': productId,
        'hostSlug': hostSlug,
        'hostName': hostName,
        'productSlug': productSlug,
        'title': title,
        'qty': qty,
        'unitPaise': unitPaise,
        if (imageUrl != null) 'imageUrl': imageUrl,
        'colour': colour,
        'colourHex': colourHex,
        'size': size,
        'category': category,
        'maxQty': maxQty,
      };

  /// The `items[]` entry of the group checkout body.
  Map<String, Object?> toCheckoutItem() => {'productId': productId, 'colour': colour, 'size': size, 'qty': qty};
}

/// A group checkout whose online payment page was opened and not yet confirmed paid. Kept so the bag is only emptied once the
/// server says the group is paid. [fromBag] false means "Buy now" on one product (the bag is left alone).
class BagPending {
  const BagPending({required this.groupId, required this.fromBag, required this.totalPaise, required this.items});

  factory BagPending.fromJson(Map<String, dynamic> j) => BagPending(
        groupId: j['groupId'] is String ? j['groupId'] as String : '',
        fromBag: j['fromBag'] != false,
        totalPaise: j['totalPaise'] is num ? (j['totalPaise'] as num).round() : 0,
        items: j['items'] is num ? (j['items'] as num).round() : 0,
      );

  final String groupId;
  final bool fromBag;
  final int totalPaise;
  final int items;

  Map<String, Object?> toJson() => {'groupId': groupId, 'fromBag': fromBag, 'totalPaise': totalPaise, 'items': items};
}
