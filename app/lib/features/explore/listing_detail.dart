import 'package:flutter/material.dart';

import '../../core/theme.dart';
import 'product.dart';

class ListingDetail extends StatelessWidget {
  final Product product;
  const ListingDetail({super.key, required this.product});

  @override
  Widget build(BuildContext context) {
    final grad = AvaColors.thumbGradients[product.gradient % AvaColors.thumbGradients.length];
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        bottom: false,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 6),
            child: Row(children: [
              IconButton(icon: const Icon(Icons.arrow_back, color: AvaColors.ink), onPressed: () => Navigator.pop(context)),
              Text('Listing', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 18)),
              const Spacer(),
              const Icon(Icons.notifications_none_rounded, size: 22),
              const SizedBox(width: 16),
              const Icon(Icons.mail_outline, size: 22),
              const SizedBox(width: 8),
            ]),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(18, 6, 18, 18),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Container(height: 230, decoration: BoxDecoration(gradient: grad, borderRadius: BorderRadius.circular(20))),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                  decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(12)),
                  child: Text(product.category, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700))),
                const SizedBox(height: 12),
                Text(product.title, style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 26, height: 1.15)),
                const SizedBox(height: 14),
                Row(children: [
                  Container(width: 36, height: 36, decoration: BoxDecoration(
                      gradient: AvaColors.thumbGradients[(product.gradient + 2) % 5], shape: BoxShape.circle)),
                  const SizedBox(width: 10),
                  Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(product.author, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
                    Text('${product.sold} sold', style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
                  ]),
                  const Spacer(),
                  const Icon(Icons.star, color: Color(0xFFFFB400), size: 16),
                  const SizedBox(width: 3),
                  Text(product.rating, style: const TextStyle(fontWeight: FontWeight.w700)),
                ]),
                const SizedBox(height: 18),
                const Text('A hand-crafted creator product delivered instantly to your AvaTOK store. '
                    'One-time purchase. Lifetime updates, paid out straight to your AvaWallet.',
                    style: TextStyle(color: AvaColors.sub, fontSize: 14, height: 1.55)),
                const SizedBox(height: 18),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(color: AvaColors.brand50, borderRadius: BorderRadius.circular(14)),
                  child: const Row(children: [
                    Icon(Icons.bolt, color: AvaColors.brand, size: 20), SizedBox(width: 10),
                    Text('Instant delivery to your library', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                  ])),
              ]),
            ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 20),
            decoration: const BoxDecoration(color: Colors.white, border: Border(top: BorderSide(color: AvaColors.line))),
            child: Row(children: [
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Price', style: TextStyle(color: AvaColors.sub, fontSize: 12)),
                Text(product.price, style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 24)),
              ]),
              const SizedBox(width: 18),
              Expanded(child: FilledButton(
                onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Checkout wires to AvaWallet next'))),
                child: const Text('Buy now'))),
            ]),
          ),
        ]),
      ),
    );
  }
}
