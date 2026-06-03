/// A marketplace listing (AvaExplore). Static now; Nostr-backed later.
class Product {
  final String title;
  final String author;
  final String price;
  final String rating;
  final String category;
  final int gradient;
  final int sold;
  const Product({
    required this.title, required this.author, required this.price,
    required this.rating, required this.category, required this.gradient, this.sold = 0,
  });
}

const kProducts = <Product>[
  Product(title: 'Golden Hour Lightroom Presets', author: 'priya.shoots', price: '\$24', rating: '4.9', category: 'Presets', gradient: 0, sold: 1240),
  Product(title: 'Nostr Dev Starter Kit', author: 'alexc', price: 'Free', rating: '5.0', category: 'Templates', gradient: 1, sold: 3100),
  Product(title: 'Cinematic LUT Pack — Vol. 2', author: 'maya.travels', price: '\$18', rating: '4.8', category: 'Presets', gradient: 2, sold: 860),
  Product(title: 'Editing Masterclass', author: 'sarah.k', price: '\$79', rating: '4.9', category: 'Courses', gradient: 3, sold: 420),
  Product(title: 'Lo-fi Beats for Creators', author: 'arjun.makes', price: '\$12', rating: '4.7', category: 'Music', gradient: 4, sold: 670),
  Product(title: 'Brand Identity Template', author: 'lisa.codes', price: '\$32', rating: '4.9', category: 'Templates', gradient: 1, sold: 510),
];
