import 'package:flutter/material.dart';

import '../data/bag_store.dart';
import '../data/models/bag.dart';
import '../data/models/merch.dart';
import 'channel_pop_kit.dart';
import 'widgets.dart';

/// [HF-CHANNEL-APP-1] Builds the bag line for a product. Without [colour] / [size] it takes the first colour and the first size that is
/// in stock (what "+ Add" on a tile does). Returns null when sizes exist but the wanted one is sold out.
BagLine? bagLineFor({
  required PublicHost host,
  required String hostSlug,
  required PublicProduct product,
  String category = '',
  String? colour,
  String? size,
  int qty = 1,
}) {
  MerchColour? picked;
  if (product.colours.isNotEmpty) {
    picked = product.colours.firstWhere((x) => x.name == colour, orElse: () => product.colours.first);
  }
  var unit = product.fromPaise;
  var chosenSize = '';
  if (product.sizes.isNotEmpty) {
    PublicSize? found;
    for (final s in product.sizes) {
      final match = size == null ? s.inStock : s.size == size;
      if (match) {
        found = s;
        break;
      }
    }
    if (found == null || !found.inStock) return null;
    chosenSize = found.size;
    unit = found.pricePaise;
  }
  return BagLine(
    productId: product.id,
    hostSlug: hostSlug,
    hostName: host.displayName,
    productSlug: product.slug,
    title: product.title,
    qty: qty,
    unitPaise: unit,
    imageUrl: product.imageUrl,
    colour: picked?.name ?? '',
    colourHex: picked?.hex ?? '',
    size: chosenSize,
    category: category,
    maxQty: product.maxQty,
  );
}

/// Puts [line] in the bag, counts it and says so. False when the bag is full.
Future<bool> addLineToBag(BuildContext context, BagLine line, {String surface = 'channel'}) async {
  final ok = await BagStore.instance.add(line);
  if (ok) {
    channelEvent('bag_added', {'surface': surface, 'category': line.category, 'qty': line.qty, 'price_rupees': line.unitPaise ~/ 100});
  }
  if (context.mounted) {
    toast(context, ok ? 'Added to your bag.' : 'Your bag is full. Check out first, then add more.');
  }
  return ok;
}
