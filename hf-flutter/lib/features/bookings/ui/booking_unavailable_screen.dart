import 'package:flutter/material.dart';

class BookingUnavailableScreen extends StatelessWidget {
  const BookingUnavailableScreen({super.key, this.title = 'Bookings'});
  final String title;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(title)),
    body: const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Text('Bookings are not available yet. Please check back later.'),
      ),
    ),
  );
}
